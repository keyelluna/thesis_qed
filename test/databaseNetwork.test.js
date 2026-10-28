const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { ipv4DatabaseStream } = require('../src/operations/databaseReliability');

function fixture(enableKeepAlive=true) {
 const socket=new EventEmitter(),calls=[];socket.setNoDelay=value=>calls.push(['noDelay',value]);socket.setKeepAlive=(...args)=>calls.push(['keepAlive',...args]);
 const config={host:'database.example.invalid',port:3307,enableKeepAlive,keepAliveInitialDelay:10000,connectTimeout:10000,ssl:{rejectUnauthorized:true,verifyIdentity:true}};let options;
 const result=ipv4DatabaseStream({config},value=>{options=value;return socket;});return {socket,calls,config,options,result};
}
test('database uses IPv4 without automatic IPv6 fallback, retaining DNS hostname and configured port',()=>{
 const f=fixture();assert.deepEqual(f.options,{host:'database.example.invalid',port:3307,family:4,autoSelectFamily:false});assert.equal(f.result,f.socket);
 assert.equal(f.config.connectTimeout,10000);assert.deepEqual(f.config.ssl,{rejectUnauthorized:true,verifyIdentity:true});assert.deepEqual(f.calls,[['noDelay',true]]);
});
test('custom mysql2 stream keeps TCP no-delay and enables keepalive when connected',()=>{
 const f=fixture();f.socket.emit('connect');assert.deepEqual(f.calls,[['noDelay',true],['keepAlive',true,10000]]);assert.equal(f.socket.listenerCount('connect'),0);
});
test('custom stream honors disabled keepalive',()=>{
 const f=fixture(false);f.socket.emit('connect');assert.deepEqual(f.calls,[['noDelay',true]]);
});
test('IPv4 stream connects to a real local TCP listener and passes data',async()=>{
 const server=net.createServer(socket=>socket.end('connected'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let socket;
 try{socket=ipv4DatabaseStream({config:{host:'localhost',port:server.address().port,enableKeepAlive:true,keepAliveInitialDelay:10000}});let data='';socket.setEncoding('utf8');await new Promise((resolve,reject)=>{socket.on('data',part=>data+=part);socket.once('end',resolve);socket.once('error',reject);});assert.equal(socket.remoteFamily,'IPv4');assert.equal(data,'connected');}
 finally{socket?.destroy();await new Promise(resolve=>server.close(resolve));}
});
