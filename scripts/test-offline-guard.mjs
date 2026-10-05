// Optional test preload: fail BEFORE any non-loopback TCP connection or DNS
// lookup. Inherit through NODE_OPTIONS so child Node test runners are covered.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const local = host => host === undefined || host === null || ['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
function blocked() {
  process.stderr.write('OFFLINE_TEST_NETWORK_BLOCKED\n' + new Error('A test attempted external network access').stack + '\n');
  process.exit(86);
}
function checkRequest(args) {
  for (const arg of args.slice(0,2)) {
    if(typeof arg === 'string' || arg instanceof URL) {
      if(!local(new URL(arg).hostname)) blocked();
    } else if(arg && typeof arg === 'object' && !arg.socketPath) {
      if(!local(arg.hostname ?? arg.host)) blocked();
    }
  }
}
for(const module of [http,https]) for(const name of ['request','get']) {
  const original = module[name];
  module[name] = function(...args) {checkRequest(args);return Reflect.apply(original,this,args);};
}
if(globalThis.fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = function(input,options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if(!local(url.hostname)) blocked();
    return original(input,options);
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const second = Array.isArray(args[0]) ? args[0][1] : args[1];
  if (first && typeof first === 'object') {
    if (!first.path && !local(first.host)) blocked();
  } else if (typeof first === 'number' && !local(typeof second === 'string' ? second : undefined)) blocked();
  return Reflect.apply(connect, this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!local(host)) blocked();
  return Reflect.apply(lookup, this, [host, ...args]);
};
syncBuiltinESMExports();
