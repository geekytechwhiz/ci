// CommonJS for serverless-esbuild
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');

module.exports = [
  {
    name: 'nx-workspace-resolver',
    setup(build) {
      const workspaceRoot = resolve(__dirname, '../..');
      const workspacePackages = {
        '@api-hub/observability': resolve(workspaceRoot, 'libs/observability/src/index.ts'),
        '@api-hub/utils': resolve(workspaceRoot, 'libs/utils/src/index.ts'),
        '@api-hub/workflow-runtime-core': resolve(workspaceRoot, 'libs/workflow-runtime-core/src/index.ts'),
        '@api-hub/event-platform': resolve(workspaceRoot, 'libs/event-platform/src/index.ts'),
        '@api-hub/middleware': resolve(workspaceRoot, 'libs/middleware/src/index.ts'),
        '@api-hub/service-clients': resolve(workspaceRoot, 'libs/service-clients/src/index.ts'),
      };

      build.onResolve({ filter: /^@api-hub\/.*/ }, (args) => {
        const packagePath = workspacePackages[args.path];
        if (!packagePath || !existsSync(packagePath)) return;
        return { path: packagePath };
      });
    },
  },
];
