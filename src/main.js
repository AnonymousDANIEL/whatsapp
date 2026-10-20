'use strict';
require('dotenv').config({ quiet: true });
const { validateStartupEnvironment, describeStartupError } = require('./startup');
let stage = 'configuration';
(async () => {
  validateStartupEnvironment(process.env);
  stage = 'database';
  const { migrateStartup } = require('./db');
  console.log('Database schema ready:', JSON.stringify(await migrateStartup()));
  stage = 'service';
  await require('./' + process.env.SERVICE_ROLE).start();
})().catch(e => { console.error(describeStartupError(e, stage)); process.exit(1); });
