'use strict';
const os = require('os') 
  , fs = require('fs')
  , stream = require('stream')
  , fluentlogger = require('fluent-logger')
  , logrotate = require('logrotate-stream')
  , zeromq = require('zmq')
  , sock = zeromq.socket('pub')
  , clc = require('cli-color')
  , humanize = require('humanize-number')
  , uuid = require('uuid')

let collector;
function app(level, data) {
  data = data.toString().replace(/(?:\r\n|\r|\n)\s\s+/g, ' ');
  let log = {
    class: 'application',
    host: os.hostname(),
    pid: process.pid,
    severity: level.toUpperCase(),
    message: data.substring(0, 100)
  }
  if(process.env.NODE_ENV === "development") {
    pipeLogs(log);
    if(level == 'error') {
      console.log(clc.redBright(data));
    } else {
      console.log(clc.blackBright(data))
    }
  } else {
    if(level == 'error'){
      log.trace = data;
    }
    collectLogs('application', log);
  }
}

function request() {
  return function *(next) {
    let reqTime = new Date;
    try {
      yield next;
    } catch (err) {
      throw err;
    }
    let onFinish = done.bind(null, 'finish');
    let onClose = done.bind(null, 'close');
    let ctx = this;
    let res = this.res;
    res.once("finish", onFinish);
    res.once("close", onClose);
    function done(evt) {
      let resTime = new Date;
      let resolvedTime = time(reqTime);
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      let classname = (ctx.request.headers['x-correlation-id']) ? 'service_request' : 'client_request';
      let correlationId = uuid.v4();
      let requestId = uuid.v4();
      let request = {
        request_id: requestId,
        class: classname,
        message: `${ctx.request.method} ${ctx.request.url}`,
        host: ctx.request.host,
        client: ctx.request.ip || ctx.request.headers['x-forwarded-for'],
        path: ctx.request.url,
        method: ctx.request.method,
        request_time: Date().toString(),
        correlation_id: ctx.request.headers['x-correlation-id'] || correlationId,
        severity: 'INFO',
        metadata: {}
      }
      let response = {
        request_id: requestId,
        class: classname,
        message: `${ctx.response.status} ${ctx.response.message} ${ctx.request.url}`,
        host: ctx.request.host,
        client: ctx.request.ip || ctx.request.headers['x-forwarded-for'],
        path: ctx.request.url,
        method: ctx.request.method,
        response_time: resTime.toString(),
        resolution_time: resolvedTime,
        correlation_id: correlationId,
        status: ctx.response.status,
        severity: ctx.response.status >= 400 ? 'ERROR' : 'INFO',
        metadata: {}
      }
      if(process.env.NODE_ENV === "development") {
        dev(ctx, reqTime, resTime, resolvedTime);
      } else {
        collectLogs('request', request);
        collectLogs('response', response);
      }
    }
  }
}

function dev(ctx, reqTime, resTime, resolvedTime) {
  let requestClass = (ctx.request.headers['x-correlation-id']) ? 'service_request' : 'client_request';
  let correlationId = uuid.v4();
  let requestId = uuid.v4();
  let request = {
    class: requestClass,
    message: `${ctx.request.method} ${ctx.request.url}`,
    host: os.hostname(),
    path: ctx.request.url,
    method: ctx.request.method,
    request_id: requestId,
    correlation_id: ctx.request.headers['x-correlation-id'] || correlationId,
    request_time: reqTime.toString(),
    client: ctx.request.ip || ctx.request.headers['x-forwarded-for'],
    pid: process.pid,
    severity: 'INFO',
    metadata: {},
  }
  let response = {
    class: requestClass,
    message: `${ctx.response.status} ${ctx.response.message} ${ctx.request.url}`,
    host: os.hostname(),
    client: ctx.request.ip || ctx.request.headers['x-forwarded-for'],
    path: ctx.request.url,
    method: ctx.request.method,
    request_id: requestId,
    correlation_id: ctx.request.header['x-correlation-id'] || correlationId,
    response_time: resTime.toString(),
    resolution_time: resolvedTime,
    status: ctx.response.status,
    pid: process.pid,
    severity: ctx.response.status >= 400 ? 'ERROR' : 'INFO',
    metadata: {},
  }
  console.log(clc.cyanBright(request.message));
  if(severity === 'ERROR') {
    console.log(clc.redBright(response.message)) 
  } else {
    console.log(clc.greenBright(response.message));
  }
  pipeLogs(request);
  pipeLogs(response);
}

function pipeLogs(data) {
  let bufferStream = new stream.PassThrough()
  bufferStream.end(new Buffer(JSON.stringify(data) + '\n'));
  if (!fs.existsSync('./logs')){
    fs.mkdirSync('./logs');
  }
  let toLogFile = logrotate({ file: './logs/out.log', size: '100k', keep: 7 });
  bufferStream.pipe(toLogFile);
}

// collectors 
function fluent(config) {
  fluentlogger.configure('tag_prefix', {
    host: config.host,
    port: config.port,
    timeout: 3.0,
    reconnectInterval: 600000 // 10 minutes
  });
  collector = 'fluent';
}

function zmq(addr) {
  sock.connect(`tcp://${addr}`);
  collector = 'zmq';
}

function collectLogs(type, data) {
  switch (collector) {
    case "fluent":
      fluentlogger.emit('label', data);
      break;
    case "zmq":
      sock.send([type, JSON.stringify(data)]);
      break;
    default:
      console.log("Not a valid log collector");
  }
}

function time(start) {
  var delta = new Date - start;
  delta = delta < 10000
    ? delta + 'ms'
    : Math.round(delta / 1000) + 's';
  return humanize(delta);
}

module.exports = {
  app: app,
  fluent: fluent,
  zmq: zmq,
  request: request
}