/**
 * Optional integrations with the user's UNMODIFIED, locally installed agent CLIs.
 * Wizard does not implement OAuth, read credentials, or provide a token proxy.
 * Each invocation receives only the explicit Wizard prompt in an isolated cwd.
 *
 * Important: Claude's third-party authentication policy is provider-controlled.
 * Only call the installed CLI as its authenticated end user, not as a hosted
 * intermediary. Wizard never imports Claude subscription tokens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {parseJsonContent} from './llm-client.mjs';

const MAX_CAPTURE=2*1024*1024;
const DEFAULT_TIMEOUT=180000;

export function executeCli(binary,args,{input='',cwd,timeoutMs=DEFAULT_TIMEOUT,spawnImpl=spawn}={}){
  if(!cwd)throw Error('Isolated working directory required');
  if(!Number.isFinite(Number(timeoutMs))||Number(timeoutMs)<=0)
    throw Error('CLI timeout must be positive');
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(binary,args,{
      cwd,env:process.env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true
    });
    let stdout='',stderr='',done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      if(error)reject(error);else resolve(value);
    };
    const timer=setTimeout(()=>{
      child.kill('SIGKILL');finish(Error(binary+' timed out'));
    },Number(timeoutMs));
    child.once('error',error=>finish(Error(binary+' unavailable: '+error.message)));
    child.stdout?.on('data',buf=>{
      stdout+=buf.toString();
      if(stdout.length>MAX_CAPTURE){child.kill('SIGKILL');finish(Error(binary+' output exceeded limit'));}
    });
    child.stderr?.on('data',buf=>{
      stderr+=buf.toString();
      if(stderr.length>MAX_CAPTURE){child.kill('SIGKILL');finish(Error(binary+' diagnostics exceeded limit'));}
    });
    child.once('close',code=>{
      if(code!==0)return finish(Error(binary+' failed (exit '+code+'): '+stderr.slice(-650)));
      finish(null,{stdout,stderr});
    });
    child.stdin?.on('error',error=>{if(error.code!=='EPIPE')finish(error);});
    child.stdin?.end(input);
  });
}
export class AccountCliClient {
  constructor({provider,model=null,timeoutMs=DEFAULT_TIMEOUT,run=executeCli}={}){
    if(!['codex-account','claude-code-account'].includes(provider))throw Error('Unknown account CLI provider');
    this.provider=provider;this.model=model||null;this.auth='local-cli-user-account';
    this.timeoutMs=Number(timeoutMs);this.run=run;
  }
  async _withScratch(action){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-llm-'));
    fs.chmodSync(dir,0o700);
    try{return await action(dir);}
    finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  async completeJson({system,user}={}){
    if(typeof system!=='string'||typeof user!=='string')throw Error('Prompt requires system and user text');
    const input=system+'\n\nReturn machine-readable JSON only. Do not access external files, run tools, or execute code.\n\n'+user;
    return this._withScratch(async cwd=>{
      let text;
      if(this.provider==='codex-account'){
        const answer=path.join(cwd,'answer.txt');
        const args=['exec','--sandbox','read-only','--ask-for-approval','never',
          '--skip-git-repo-check','--output-last-message',answer];
        if(this.model)args.push('--model',this.model);
        args.push('-');
        await this.run('codex',args,{input,cwd,timeoutMs:this.timeoutMs});
        if(!fs.existsSync(answer))throw Error('Codex did not produce a final answer');
        text=fs.readFileSync(answer,'utf8');
      }else{
        const args=['--bare','--tools','','--disallowedTools','mcp__*',
          '--permission-mode','dontAsk','--disable-slash-commands',
          '--no-session-persistence','--output-format','text'];
        if(this.model)args.push('--model',this.model);
        args.push('-p');
        const result=await this.run('claude',args,{input,cwd,timeoutMs:this.timeoutMs});
        text=result.stdout;
      }
      return parseJsonContent(text);
    });
  }
  async doctor(){
    return this._withScratch(async cwd=>{
      const binary=this.provider==='codex-account'?'codex':'claude';
      const args=binary==='codex'?['login','status']:['auth','status'];
      await this.run(binary,args,{cwd,timeoutMs:15000});
      return {ok:true,provider:this.provider,auth:this.auth,
        required_binary:binary,requested_model:this.model,
        note:'Authentication and eligible usage are controlled by the installed CLI and its provider; no tokens are collected by Wizard.'};
    });
  }
}
