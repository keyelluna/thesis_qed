const test=require('node:test');
const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');
const {randomBytes}=require('node:crypto');
// Execute actual socket authentication and connection callbacks with an inert
// socket transport. No listener, real accounts, mailer or database is loaded.
class Server {
 constructor(){this.handlers={};}
 use(fn){this.authenticate=fn;}
 on(name,fn){this.handlers[name]=fn;}
}
const id=require.resolve('socket.io');
require.cache[id]={id,filename:id,loaded:true,exports:{Server}};
const {initSocket,userSockets}=require('../socket');
const secret=randomBytes(32).toString('hex'),previous=process.env.JWT_SECRET;
process.env.JWT_SECRET=secret;
const server=initSocket(null,[]);
test.after(()=>{if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
function authenticate(claims){
 const token=claims===undefined?undefined:jwt.sign(claims,secret,{expiresIn:'5m'});
 const socket={handshake:{headers:{cookie:token?'token='+token:undefined}},id:'synthetic-socket',rooms:[],events:{},join(room){this.rooms.push(room);},on(name,fn){this.events[name]=fn;}};
 let error;server.authenticate(socket,value=>{error=value;});return{socket,error};
}
for(const role of ['ADMIN','PRINCIPAL','TEACHER','PARENT'])test(role+' socket joins only authenticated auth ID',()=>{
 const {socket,error}=authenticate({userId:101,role});assert.equal(error,undefined);
 const old=console.log;console.log=()=>{};try{server.handlers.connection(socket);assert.deepEqual(socket.rooms,['user:101']);assert.equal(socket.events.join,undefined);socket.events.disconnect();assert.equal(userSockets.size,0);}finally{console.log=old;}
});
for(const claims of [undefined,{userId:101,role:'PRINCIPAL',purpose:'password_reset'},{userId:101,role:'UNKNOWN'},{userId:101,role:['ADMIN']},{id:101,role:'PRINCIPAL'},{userId:0,role:'PRINCIPAL'}])test('socket rejects malformed/recovery identity '+JSON.stringify(claims),()=>{assert.ok(authenticate(claims).error instanceof Error);});
