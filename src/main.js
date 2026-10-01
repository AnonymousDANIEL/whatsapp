'use strict';
require('dotenv').config();
const { migrate } = require('./db');
(async () => {
  if (!['api', 'worker'].includes(process.env.SERVICE_ROLE)) throw new Error('SERVICE_ROLE must be api or worker');
  if ((process.env.INTERNAL_SECRET || '').length < 32) throw new Error('INTERNAL_SECRET must be at least 32 characters');
  await migrate();
  await require('./' + process.env.SERVICE_ROLE).start();
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
