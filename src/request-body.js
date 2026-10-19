'use strict';
// API-only parsing. Authenticate private requests before reading upload bodies;
// public payment/feed callbacks keep their own bounded parsing and raw MAC data.
const express = require('express');
const {rateLimit} = require('express-rate-limit');

const loginJSON = express.json({limit:'4kb'});
function publicCallbacks(app) {
  const paymentLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false});
  const bankLimit=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
  app.post('/api/payments/callback/:id',paymentLimit,express.json({limit:'32kb'}));
  app.post('/api/banks/feed/:id',bankLimit,(req,res,next)=>{
    if(!/^\d{10}$/.test(req.headers['x-bank-timestamp']||'')||!/^[\da-f]{64}$/i.test(req.headers['x-bank-signature']||''))return res.status(403).json({error:'Bank feed authentication required'});
    next();
  },express.json({limit:'8mb',verify(req,res,body){req.rawBankBody=Buffer.from(body);}}));
}
function protectedAPI(app,authenticate) {
  app.use('/api',authenticate);
  app.use(['/api/password','/api/users/password-access'],express.json({limit:'4kb'}));
  app.use('/api',express.json({limit:'8mb'}));
}
module.exports={loginJSON,publicCallbacks,protectedAPI};
