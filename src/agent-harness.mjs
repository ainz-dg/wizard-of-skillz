/**
 * Thin adapter boundary for user-installed, tool-enabled coding agents.
 * Legacy model clients remain separate: they receive explicit snippets and do
 * not gain workspace tools through this interface.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const MAX_CAPTURE=4*1024*1024;
const DEFAULT_TIMEOUT=300000;
const SKILL_PATH=fileURLToPath(new URL('../skills/wizard-of-skillz/SKILL.md',import.meta.url));
const PROVIDERS=Object.freeze([
  {id:'codex',label:'Codex CLI',implemented:true,binary:'codex'},
  {id:'claude-code',label:'Claude Code',implemented:false,binary:'claude'},
  {id:'copilot-cli',label:'GitHub Copilot CLI',implemented:false,binary:'copilot'},
  {id:'opencode',label:'OpenCode',implemented:false,binary:'opencode'}
]);

export function agentProviders(){return PROVIDERS.map(p=>({...p}));}

function hasGitMetadata(root){
  let current=root;
  while(true){
    try{
      const metadata=fs.lstatSync(path.join(current,'.git'));
      if(metadata.isDirectory()||metadata.isFile())return true;
    }catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    const parent=path.dirname(current);
    if(parent===current)return false;
    current=parent;
  }
}

export function sanitizeAgentDiagnostic(value){
  return String(value??'').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,'$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s,;"']+/gi,'$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g,'[redacted-token]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'https://[redacted]@')
    .slice(-1800);
}

export function executeAgentCli(binary,args,{cwd,input='',timeoutMs=DEFAULT_TIMEOUT,
  signal=null,spawnImpl=spawn}={}){
  if(signal?.aborted)throw Error(binary+' cancelled');
  if(!cwd||!path.isAbsolute(cwd))throw Error('Agent requires an absolute workspace root');
  if(!Number.isFinite(Number(timeoutMs))||Number(timeoutMs)<=0)
    throw Error('Agent timeout must be positive');
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(binary,args,{cwd,env:process.env,shell:false,windowsHide:true,
      stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
      if(error)reject(error);else resolve(value);
    };
    const onAbort=()=>{child.kill('SIGKILL');finish(Error(binary+' cancelled'));};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error(binary+
      ' timed out after '+timeoutMs+'ms'));},Number(timeoutMs));
    child.once('error',error=>finish(Error(binary+' unavailable: '+error.message)));
    child.stdout?.on('data',buf=>{
      stdout+=buf.toString();
      if(Buffer.byteLength(stdout)>MAX_CAPTURE){child.kill('SIGKILL');
        finish(Error(binary+' output exceeded limit'));}
    });
    child.stderr?.on('data',buf=>{
      stderr+=buf.toString();
      if(Buffer.byteLength(stderr)>MAX_CAPTURE){child.kill('SIGKILL');
        finish(Error(binary+' diagnostics exceeded limit'));}
    });
    child.once('close',code=>code===0?finish(null,{stdout,stderr}):
      finish(Error(binary+' failed (exit '+code+'): '+sanitizeAgentDiagnostic(stderr))));
    child.stdin?.on('error',error=>{if(error.code!=='EPIPE')finish(error);});
    child.stdin?.end(input);
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
  });
}

function tempOutput(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-agent-'));
  fs.chmodSync(dir,0o700);
  return dir;
}

export class CodexAgentAdapter{
  constructor({model=null,timeoutMs=DEFAULT_TIMEOUT,run=executeAgentCli}={}){
    this.provider='codex';this.model=model?.trim()||null;
    this.timeoutMs=Number(timeoutMs);this.run=run;
  }
  async doctor(){
    const dir=tempOutput();
    try{
      const version=await this.run('codex',['--version'],{cwd:dir,timeoutMs:15000});
      await this.run('codex',['login','status'],{cwd:dir,timeoutMs:15000});
      return {ok:true,provider:this.provider,version:version.stdout.trim(),
        model:this.model??'CLI default',auth:'configured Codex CLI account'};
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  async reviewWorkspace({workspaceRoot,skillText,prompt,signal=null}={}){
    if(!workspaceRoot||!path.isAbsolute(workspaceRoot))
      throw Error('Select an absolute project directory first');
    const root=fs.realpathSync(workspaceRoot);
    if(!fs.statSync(root).isDirectory())throw Error('Selected workspace is not a directory');
    if(typeof skillText!=='string'||!skillText.trim()||skillText.length>100000)
      throw Error('Wizard skill is missing or too large');
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>50000)
      throw Error('Agent review prompt is missing or too large');
    const out=tempOutput(),answer=path.join(out,'last-message.md');
    try{
      const args=['--ask-for-approval','never','exec','--sandbox','read-only',
        '--ephemeral','--cd',root,'--output-last-message',answer];
      if(!hasGitMetadata(root))args.splice(args.indexOf('exec')+1,0,'--skip-git-repo-check');
      if(this.model)args.push('--model',this.model);
      args.push('-');
      await this.run('codex',args,{cwd:root,input:prompt,timeoutMs:this.timeoutMs,signal});
      const stat=fs.lstatSync(answer);
      if(!stat.isFile()||stat.size>MAX_CAPTURE)throw Error('Codex final report missing or too large');
      return {provider:this.provider,model:this.model??'CLI default',
        report:fs.readFileSync(answer,'utf8'),skill_sha256:hash(skillText)};
    }finally{fs.rmSync(out,{recursive:true,force:true});}
  }
}

const hash=value=>createHash('sha256').update(value).digest('hex');

export function createAgentHarness({provider='codex',model=null,timeoutMs,run}={}){
  if(provider!=='codex'){
    const found=PROVIDERS.find(x=>x.id===provider);
    if(found&&!found.implemented)
      throw Error(found.label+' agent adapter is not part of this experimental slice yet');
    throw Error('Unknown agent provider: '+provider);
  }
  return new CodexAgentAdapter({model,timeoutMs,run});
}

export function loadWizardSkill(){
  return fs.readFileSync(SKILL_PATH,'utf8');
}
