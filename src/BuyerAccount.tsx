import {useState} from 'react';
import {api,type Session} from './api';

export function BuyerAccount({session,onChanged}:{session:Session|null;onChanged:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!session?.googleEnabled)return null;
 return <div className="buyer-account">
  {session.user?<><span>{session.user.name}</span><button className="text-button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/api/auth/logout','POST',{});onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>ログアウト</button></>:<a href="/api/auth/google/start?returnTo=%2F%23history">Googleでログイン</a>}
  {error&&<span role="alert">{error}</span>}
 </div>;
}
