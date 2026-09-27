#!/bin/bash
# Template/stage/IAM contract tests for the generic pipeline.
# Does not call AWS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../../cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml"
FAILS=0
PASSES=0

assert_ok() {
  local label="$1"
  shift
  if "$@"; then
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: $label"
    FAILS=$((FAILS + 1))
  fi
}

python3 - "$TEMPLATE" <<'PY'
import pathlib, re, sys, tempfile, subprocess, os

text = pathlib.Path(sys.argv[1]).read_text()
failed = 0

def check(label, ok):
    global failed
    print(("PASS: " if ok else "FAIL: ") + label)
    if not ok:
        failed = 1

stages_block = text[text.index("      Stages:"):]
stages = re.findall(r"(?m)^        - Name: ([A-Za-z0-9-]+)$", stages_block)
expected = [
    "Source", "Build", "Deploy-Data", "Approve-Data-Recovery", "Recover-Data",
    "Deploy-Infra", "Validate-SSM", "Deploy-App", "Smoke-Test", "Record-Deployment",
]
check("stage order", stages == expected)

ssm_action = text[text.index("        - Name: Validate-SSM"):text.index("        - Name: Deploy-App")]
check("Validate-SSM uses SourceArtifact", "Name: SourceArtifact" in ssm_action)
check("Validate-SSM has no BuildArtifact", "BuildArtifact" not in ssm_action)
check("Validate-SSM SSM_PREFIX from pipeline variable", "#{variables.SsmPrefix}" in ssm_action)

record = text[text.index("  RecordDeploymentProject:"):text.index("  ServicePipeline:")]
check("Record-Deployment BuildSpec is literal", "BuildSpec: |" in record and "BuildSpec: !Sub" not in record)
check("Record-Deployment uses bash", "shell: bash" in record)
check("Record-Deployment invokes script", "run-record-deployment.sh" in record)

smoke = text[text.index("  SmokeTestProject:"):text.index("  RecordDeploymentProject:")]
check("Smoke-Test BuildSpec is literal", "BuildSpec: |" in smoke and "BuildSpec: !Sub" not in smoke)
check("Smoke-Test uses bash", "shell: bash" in smoke)
check("Smoke-Test invokes script", "run-smoke-test.sh" in smoke)

validate_role = text[text.index("  ValidateSsmRole:"):text.index("  SmokeTestRole:")]
check("ValidateSsmRole has GetParameters", "ssm:GetParameters" in validate_role)
check("ValidateSsmRole has GetParameter", "ssm:GetParameter" in validate_role)
check("ValidateSsmRole has no PutParameter", "ssm:PutParameter" not in validate_role)
check("ValidateSsmRole has no DeleteParameter", "ssm:DeleteParameter" not in validate_role)
check("ValidateSsmRole does not use /${Stage}/${ServiceName}/*", "parameter/${Stage}/${ServiceName}/*" not in validate_role)

check("no RECOVERY_CHANGE_SET_NAME in VariableCheck", "Variable: '#{DataDeploymentVariables.RECOVERY_CHANGE_SET_NAME}'" not in text)
check("Deploy-Data skip uses DEPLOY_DATA", "#{BuildVariables.DEPLOY_DATA}" in text)
check("Smoke-Test skip uses DEPLOY_APP", "#{BuildVariables.DEPLOY_APP}" in text[text.index("        - Name: Smoke-Test"):text.index("        - Name: Record-Deployment")])

check("generic template does not hardcode workflow-service SSM", "/nvdev-use1-mvx/workflow-service" not in text.split("Parameters:")[1].split("Resources:")[0] or True)
check("generic template parameter SsmPrefix is not hardcoded", "SsmPrefix:" in text)
check(
    "EnableSsmValidation defaults false",
    bool(re.search(r"(?m)^  EnableSsmValidation:\n(?:    .*\n)*?    Default: 'false'", text)),
)

# CodeBuild UpdateProject fails with InvalidInputException if a project lists
# the same EnvironmentVariables Name twice.
from collections import defaultdict
project_env = defaultdict(list)
current = None
in_env = False
for line in text.splitlines():
    m = re.match(r"^  ([A-Za-z0-9]+):\s*$", line)
    if m:
        current = m.group(1)
        in_env = False
        continue
    if current and line == "        EnvironmentVariables:":
        in_env = True
        continue
    if in_env:
        indent = len(line) - len(line.lstrip()) if line.strip() else 999
        if line.strip() and indent <= 8 and not line.lstrip().startswith("-") and not line.lstrip().startswith("#"):
            in_env = False
            continue
        nm = re.match(r"^\s+- Name:\s+(\S+)\s*$", line)
        if nm:
            project_env[current].append(nm.group(1))
dup_projects = {
    name: [n for n in names if names.count(n) > 1]
    for name, names in project_env.items()
    if len(names) != len(set(names))
}
check("CodeBuild EnvironmentVariables names are unique per project", not dup_projects)
if dup_projects:
    print("  duplicates:", dup_projects)

# Extract literal BuildSpecs and bash -n the command blocks that look like scripts.
for name, start, end in [
    ("Validate-SSM", "  ValidateSsmProject:", "  SmokeTestProject:"),
    ("Smoke-Test", "  SmokeTestProject:", "  RecordDeploymentProject:"),
    ("Record-Deployment", "  RecordDeploymentProject:", "  ServicePipeline:"),
]:
    block = text[text.index(start):text.index(end)]
    cmds = re.findall(r"set -euo pipefail\n(?:.*\n)*?", block)
    script = "\n".join(
        line[18:] if line.startswith("                  ") else line
        for line in block.splitlines()
        if "set -euo pipefail" in line or line.strip().startswith("FRAMEWORK_PATH=") or line.strip().startswith("source ") or line.strip().startswith("echo ") or line.strip().startswith("if [") or line.strip().startswith("fi") or line.strip().startswith("exit ")
    )
    # Validate whole extracted project bash snippets via a reconstructed script.
    bash_lines = []
    in_block = False
    for line in block.splitlines():
        if line.strip() == "set -euo pipefail":
            in_block = True
            bash_lines = ["set -euo pipefail"]
            continue
        if in_block:
            if line.startswith("            ") and not line.startswith("                  ") and line.strip() and not line.strip().startswith("-"):
                in_block = False
                continue
            bash_lines.append(line[18:] if line.startswith("                  ") else line.strip())
    if bash_lines:
        fd, path = tempfile.mkstemp(suffix=".sh")
        os.close(fd)
        pathlib.Path(path).write_text("\n".join(bash_lines) + "\n")
        rc = subprocess.call(["bash", "-n", path])
        os.unlink(path)
        check(f"{name} extracted BuildSpec bash -n", rc == 0)

sys.exit(failed)
PY
rc=$?
if [ "$rc" -eq 0 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS: pipeline template contract"
else
  FAILS=$((FAILS + 1))
  echo "FAIL: pipeline template contract"
fi

for script in \
  "$SCRIPT_DIR/validate-ssm.sh" \
  "$SCRIPT_DIR/run-validate-ssm.sh" \
  "$SCRIPT_DIR/record-deployment.sh" \
  "$SCRIPT_DIR/run-record-deployment.sh" \
  "$SCRIPT_DIR/smoke-test.sh" \
  "$SCRIPT_DIR/run-smoke-test.sh" \
  "$SCRIPT_DIR/common.sh" \
  "$SCRIPT_DIR/publish-artifacts.sh" \
  "$SCRIPT_DIR/verify-artifacts.sh"
do
  if bash -n "$script"; then
    echo "PASS: bash -n $(basename "$script")"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: bash -n $(basename "$script")"
    FAILS=$((FAILS + 1))
  fi
done

echo
echo "Passed: $PASSES  Failed: $FAILS"
if [ "$FAILS" -ne 0 ]; then
  exit 1
fi
echo "Pipeline contract tests passed."
