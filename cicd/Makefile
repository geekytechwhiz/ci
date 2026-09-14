# Generic AWS CodePipeline framework operator targets.
# Run from the cicd/ directory, or: make -C cicd <target>

SHELL := /bin/bash
.DEFAULT_GOAL := help

SERVICE ?=
STAGE ?=
SCRIPTS := scripts

.PHONY: help validate validate-template validate-config scan-secrets package deploy delete verify test

help:
	@echo "Generic CodePipeline framework"
	@echo ""
	@echo "  make validate                         Validate CFN, config, YAML, secrets"
	@echo "  make validate-template                aws cloudformation validate-template + cfn-lint"
	@echo "  make validate-config                  Validate service + environment YAML"
	@echo "  make scan-secrets                     Fail on credentials / hard-coded secrets"
	@echo "  make package                          Upload cicd-framework bundle to deployment bucket"
	@echo "  make deploy SERVICE=x STAGE=y         Deploy/update pipeline stack"
	@echo "  make delete SERVICE=x STAGE=y         Delete pipeline stack"
	@echo "  make verify SERVICE=x STAGE=y         Verify stack outputs / pipeline exists"
	@echo "  make test                             Run contract tests"

validate: validate-template validate-config scan-secrets
	@echo "All validations passed."

validate-template:
	@$(SCRIPTS)/validate-template.sh

validate-config:
	@$(SCRIPTS)/validate-config.sh $(if $(SERVICE),--service $(SERVICE),) $(if $(STAGE),--stage $(STAGE),)

scan-secrets:
	@$(SCRIPTS)/scan-secrets.sh

package:
	@test -n "$(SERVICE)" || (echo "SERVICE is required"; exit 1)
	@test -n "$(STAGE)" || (echo "STAGE is required"; exit 1)
	@$(SCRIPTS)/package.sh --service $(SERVICE) --stage $(STAGE)

deploy:
	@test -n "$(SERVICE)" || (echo "SERVICE is required"; exit 1)
	@test -n "$(STAGE)" || (echo "STAGE is required"; exit 1)
	@$(SCRIPTS)/deploy-pipeline.sh --service $(SERVICE) --stage $(STAGE)

delete:
	@test -n "$(SERVICE)" || (echo "SERVICE is required"; exit 1)
	@test -n "$(STAGE)" || (echo "STAGE is required"; exit 1)
	@$(SCRIPTS)/delete-pipeline.sh --service $(SERVICE) --stage $(STAGE)

verify:
	@test -n "$(SERVICE)" || (echo "SERVICE is required"; exit 1)
	@test -n "$(STAGE)" || (echo "STAGE is required"; exit 1)
	@$(SCRIPTS)/verify-deployment.sh --service $(SERVICE) --stage $(STAGE)

test:
	@bash tests/run-all.sh
