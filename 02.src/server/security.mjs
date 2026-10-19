import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function generateTotpSecret(){
 const bytes=randomBytes(20);let bits=0,value=0,result='';
 for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}
 if(bits)result+=alphabet[(value<<(5-bits))&31];return result;
}
function decode(secret){let bits=0,value=0,bytes=[];for(const char of secret){const index=alphabet.indexOf(char);if(index<0)throw new Error('Invalid TOTP secret');value=(value<<5)|index;bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(bytes);}
export function totp(secret,step){
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=createHmac('sha1',decode(secret)).update(counter).digest();const offset=digest[19]&15;
 return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
export function verifyTotp(secret,code,now,lastStep=-1){
 if(typeof code!=='string'||!/^\d{6}$/.test(code))return null;
 const current=Math.floor(now/30000);
 for(const step of [current,current-1,current+1])if(step>lastStep&&timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(code)))return step;
 return null;
}
export const newRecoveryCodes=()=>Array.from({length:8},()=>randomBytes(10).toString('hex').toUpperCase());
