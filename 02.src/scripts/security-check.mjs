import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const portable=resolve('.tools/python/python.exe');
const python=existsSync(portable)?portable:'python';
const result=spawnSync(python,['GitSecurityTool/GitSecurityTool/block_secret.py',...process.argv.slice(2)],{
 stdio:'inherit',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}
});
if(result.error)console.error('Python 3.11+ is required to run GitSecurityTool.');
process.exit(result.status??1);
