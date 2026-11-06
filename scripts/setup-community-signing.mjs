import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const dir = path.join(homedir(), '.zhixin-ai-community-signing');
await mkdir(dir, {recursive:true});
const privatePath = path.join(dir, 'adapter_ed25519_private.pem');
try { await access(privatePath); throw new Error('Key already exists; refusing to overwrite: '+privatePath); } catch(e) { if(e.code!=='ENOENT') throw e; }
const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
await writeFile(privatePath,keys.privateKey,{flag:'wx',mode:0o600});
for(const target of ['apps/desktop/resources/adapter_ed25519_public.pem','apps/desktop/src-tauri/resources/adapter_ed25519_public.pem']) {
 await mkdir(path.dirname(target),{recursive:true});await writeFile(target,keys.publicKey,{flag:'wx'});
}
console.log('Public keys prepared. Keep the private key outside Git:',privatePath);
