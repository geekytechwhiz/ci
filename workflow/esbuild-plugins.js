// CommonJS for serverless-esbuild
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');

function findWorkspaceRoot() {
  const candidates = [
    resolve(__dirname, '..'),
    resolve(__dirname, '../..'),
  ];
  for (const root of candidates) {
    if (existsSync(resolve(root, 'libs/workflow-runtime-core/src/index.ts'))) {
      return root;
    }
  }
  return candidates[0];
}

module.exports = [
  {
    name: 'nx-workspace-resolver',
    setup(build) {
      const workspaceRoot = findWorkspaceRoot();
      const workspacePackages = {
        '@api-hub/observability': resolve(workspaceRoot, 'libs/observability/src/index.ts'),
        '@api-hub/utils': resolve(workspaceRoot, 'libs/utils/src/index.ts'),
        '@api-hub/workflow-runtime-core': resolve(workspaceRoot, 'libs/workflow-runtime-core/src/index.ts'),
        '@api-hub/event-platform': resolve(workspaceRoot, 'libs/event-platform/src/index.ts'),
        '@api-hub/middleware': resolve(workspaceRoot, 'libs/middleware/src/index.ts'),
        '@api-hub/service-clients': resolve(workspaceRoot, 'libs/service-clients/src/index.ts'),
        '@api-hub/runtime-metadata': resolve(workspaceRoot, 'libs/runtime-metadata/src/index.ts'),
        '@api-hub/runtime-response-projector': resolve(
          workspaceRoot,
          'libs/runtime-response-projector/src/index.ts',
        ),
        '@api-hub/metadata-projection': resolve(workspaceRoot, 'libs/metadata-projection/src/index.ts'),
        '@api-hub/metadata': resolve(workspaceRoot, 'libs/metadata/src/index.ts'),
        '@api-hub/fhir': resolve(workspaceRoot, 'libs/fhir/src/index.ts'),
        '@api-hub/fhir/middleware': resolve(workspaceRoot, 'libs/fhir/src/middleware/index.ts'),
        '@api-hub/fhir-validator': resolve(workspaceRoot, 'libs/fhir-validator/src/index.ts'),
      };

      build.onResolve({ filter: /^@api-hub\/.*/ }, (args) => {
        const packagePath = workspacePackages[args.path];
        if (!packagePath || !existsSync(packagePath)) return;
        return { path: packagePath };
      });
    },
  },
];
