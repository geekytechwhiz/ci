#!/usr/bin/env node
'use strict';

/**
 * Discover Lambda ZIP artifacts from the generated CloudFormation template
 * (app/packaged.yaml) and the Serverless package output directories.
 *
 * Authoritative sources:
 *   1. AWS::Lambda::Function Properties.Code.S3Key in the packaged template
 *   2. Matching *.zip files under Serverless package dirs (.serverless/, app/.serverless/)
 *
 * Does not read .serverless/s3keys.txt — that file is not produced by Serverless.
 *
 * Usage:
 *   SEARCH_DIRS=".serverless:app/.serverless" \
 *     node discover-lambda-artifacts.cjs <packaged-template> [--require-zips]
 *
 * Prints JSON to stdout. Human-readable summary to stderr.
 */

const fs = require('fs');
const path = require('path');

const templatePath = process.argv[2];
const requireZips = process.argv.includes('--require-zips');

if (!templatePath) {
  console.error('ERROR: discover-lambda-artifacts.cjs requires a packaged template path');
  process.exit(1);
}

if (!fs.existsSync(templatePath)) {
  console.error(`ERROR: Packaged template not found: ${templatePath}`);
  process.exit(1);
}

const searchDirs = String(process.env.SEARCH_DIRS || '.serverless:app/.serverless')
  .split(':')
  .map((d) => d.trim())
  .filter(Boolean);

function parseTemplate(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: Packaged template is not JSON CloudFormation output: ${err.message}`);
    console.error('Serverless package must emit cloudformation-template-*-stack.json copied to packaged.yaml');
    process.exit(1);
  }
}

function zipNameFromS3Key(s3Key) {
  const key = String(s3Key || '').split('@')[0];
  return path.basename(key);
}

function findLocalZip(zipName) {
  for (const dir of searchDirs) {
    const candidate = path.join(dir, zipName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectLambdaCode(tpl) {
  const entries = [];
  const resources = (tpl && tpl.Resources) || {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!resource || resource.Type !== 'AWS::Lambda::Function') continue;
    const code = resource.Properties && resource.Properties.Code;
    if (!code) {
      entries.push({ logicalId, kind: 'missing-code' });
      continue;
    }
    if (code.ImageUri) {
      entries.push({ logicalId, kind: 'image' });
      continue;
    }
    if (code.ZipFile) {
      entries.push({ logicalId, kind: 'inline' });
      continue;
    }
    if (!code.S3Key) {
      entries.push({ logicalId, kind: 'missing-s3key', code });
      continue;
    }
    entries.push({
      logicalId,
      kind: 's3',
      originalS3Key: code.S3Key,
      originalS3Bucket: code.S3Bucket || null,
      zipName: zipNameFromS3Key(code.S3Key),
    });
  }
  return entries;
}

const tpl = parseTemplate(fs.readFileSync(templatePath, 'utf8'));
const entries = collectLambdaCode(tpl);
const artifacts = [];
const errors = [];

for (const entry of entries) {
  if (entry.kind === 'image' || entry.kind === 'inline') {
    console.error(`WARN: ${entry.logicalId} uses ${entry.kind} code; no ZIP to publish`);
    continue;
  }
  if (entry.kind !== 's3') {
    errors.push(`${entry.logicalId} has no Code.S3Key (kind=${entry.kind})`);
    continue;
  }
  const localPath = findLocalZip(entry.zipName);
  if (!localPath) {
    errors.push(
      `${entry.logicalId} -> ${entry.zipName} not found in ${searchDirs.join(', ')} (S3Key=${entry.originalS3Key})`
    );
    continue;
  }
  artifacts.push({
    logicalId: entry.logicalId,
    zipName: entry.zipName,
    localPath,
    originalS3Key: entry.originalS3Key,
  });
}

if (requireZips && artifacts.length === 0 && entries.some((e) => e.kind === 's3' || e.kind === 'missing-s3key')) {
  errors.push(`No Lambda ZIP artifacts discovered from ${templatePath}`);
}

if (errors.length === 0 && artifacts.length === 0 && entries.length === 0) {
  // No Lambda functions — valid for data/infra templates, not for app.
}

if (errors.length > 0) {
  console.error('ERROR: Lambda artifact discovery failed:');
  for (const err of errors) console.error(`  - ${err}`);
  console.error('Searched:');
  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      const names = fs.readdirSync(dir).filter((n) => n.endsWith('.zip'));
      console.error(`  ${dir}: ${names.length ? names.join(', ') : '(no zip files)'}`);
    } else {
      console.error(`  ${dir}: (directory missing)`);
    }
  }
  process.exit(1);
}

console.error('Lambda artifacts discovered:');
if (artifacts.length === 0) {
  console.error('  (none)');
} else {
  for (const art of artifacts) {
    console.error(`  ${art.zipName}`);
  }
}

process.stdout.write(JSON.stringify({ template: templatePath, artifacts }, null, 2) + '\n');
