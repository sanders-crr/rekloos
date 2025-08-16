#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const testTypes = {
  unit: 'tests/unit/**/*.test.js',
  integration: 'tests/integration/**/*.test.js',
  all: 'tests/**/*.test.js'
};

function runTests(pattern, options = {}) {
  const jestArgs = [
    '--testPathPattern=' + pattern,
    '--passWithNoTests'
  ];

  if (options.coverage) {
    jestArgs.push('--coverage');
  }

  if (options.watch) {
    jestArgs.push('--watch');
  }

  if (options.verbose) {
    jestArgs.push('--verbose');
  }

  if (options.silent) {
    jestArgs.push('--silent');
  }

  const jest = spawn('npx', ['jest', ...jestArgs], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..')
  });

  jest.on('close', (code) => {
    process.exit(code);
  });
}

function main() {
  const args = process.argv.slice(2);
  const testType = args[0] || 'all';
  
  const options = {
    coverage: args.includes('--coverage'),
    watch: args.includes('--watch'),
    verbose: args.includes('--verbose'),
    silent: args.includes('--silent')
  };

  const pattern = testTypes[testType] || testTypes.all;
  
  console.log(`Running ${testType} tests...`);
  runTests(pattern, options);
}

if (require.main === module) {
  main();
}