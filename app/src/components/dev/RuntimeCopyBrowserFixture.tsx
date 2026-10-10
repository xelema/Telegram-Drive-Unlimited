import {useEffect,useState} from 'react';
import {ErrorBoundary} from '../shared/ErrorBoundary';
import {UpdateBanner} from '../shared/UpdateBanner';
import {WhatsNewDialog} from '../shared/WhatsNewDialog';
import i18n,{ensureLanguageResource} from '../../i18n';
import {getLanguageInfo} from '../../i18n/languages';
import type {UpdateInstallPhase} from '../../services/updateReliability';

function Failure({failed}:{failed:boolean}) {if(failed)throw new Error('Controlled browser render failure');return <p>Healthy content</p>;}

/** Real recovery/update presentation; the browser controls rendering and language only. */
export function RuntimeCopyBrowserFixture(){
 const [language,setLanguage]=useState(new URLSearchParams(location.search).get('locale')??'es');
 const [ready,setReady]=useState(false),[failed,setFailed]=useState(false),[notes,setNotes]=useState(false);
 const [phase,setPhase]=useState<UpdateInstallPhase|null>(null);
 useEffect(()=>{let live=true;void ensureLanguageResource(language).then(()=>i18n.changeLanguage(language)).then(()=>{
  if(!live)return;document.documentElement.lang=language;document.documentElement.dir=getLanguageInfo(language).dir;setReady(true);
 });return()=>{live=false;};},[language]);
 if(!ready)return null;
 return <main data-runtime-language={language} className="min-h-screen bg-app-canvas p-4 pt-24 text-app-text">
  <label>Fixture language<select value={language} onChange={event=>setLanguage(event.target.value)}><option value="es">Español</option><option value="ar">العربية</option><option value="ja">日本語</option></select></label>
  <button onClick={()=>setFailed(true)}>Fail rendering</button><button onClick={()=>setNotes(true)}>Open release notes</button>
  <button onClick={()=>setPhase('downloading')}>Download phase</button><button onClick={()=>setPhase('verifying')}>Verify phase</button><button onClick={()=>setPhase('installing')}>Install phase</button>
  <UpdateBanner available version="4.0.0" downloading={phase!==null} progress={42} phase={phase} managedByPackageManager={false} onUpdate={()=>setPhase('downloading')} onDismiss={()=>setPhase(null)} />
  <ErrorBoundary><Failure failed={failed}/></ErrorBoundary>
  {notes&&<WhatsNewDialog details={{version:'4.0.0',updated:true}} onClose={()=>setNotes(false)} />}
 </main>;
}
