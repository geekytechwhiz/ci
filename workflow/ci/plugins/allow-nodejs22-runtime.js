'use strict';

/**
 * Serverless Framework 3.40.0's AWS JSON schema predates Lambda nodejs22.x.
 * AWS Lambda and this service use Node.js 22; this plugin extends the schema
 * so configuration validation accepts the runtime we actually deploy.
 *
 * Do not treat this as permission to ignore other schema failures.
 */
class AllowNodejs22Runtime {
  constructor(serverless) {
    this.serverless = serverless;
    this.hooks = {};
    this.extendSchema();
  }

  extendSchema() {
    const runtime = 'nodejs22.x';
    const handler = this.serverless && this.serverless.configSchemaHandler;
    const defs = handler && handler.schema && handler.schema.definitions;
    const target = defs && defs.awsLambdaRuntime;
    if (!target || !Array.isArray(target.enum)) {
      return;
    }
    if (!target.enum.includes(runtime)) {
      target.enum.push(runtime);
    }
  }
}

module.exports = AllowNodejs22Runtime;
