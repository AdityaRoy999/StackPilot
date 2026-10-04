"""Render the production UI in an owned host tab with synthetic API responses.

The settings/viewer binding is mocked here; real workers are covered by
browser_sandbox_switch_smoke.py. No user cookies, provider calls or DB writes.
Run inside ai-service with this file and mobile_layout_smoke.py in /tmp.
"""
import asyncio
import base64
import json
import time
from pathlib import Path
import websockets
from mobile_layout_smoke import CDP, wait_for
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

SESSION = "a5ec02c3-ec55-4b50-925a-1e1eab5c01ae"


class FrontendCDP(CDP):
    async def fulfill(self, params):
        url = params["request"]["url"]
        if "/ai/browser-ticket/" in url:
            data = dict(ticket="owned-ui-fixture", control=True)
        elif "/ai/sessions" in url:
            data = dict(session=dict(id=SESSION, title="Owned startup QA", messages=[], session_type="agent_chat"), sessions=[])
        elif "/auth/me" in url:
            data = dict(user=dict(id="owned-ui-fixture", username="Startup QA", preferences={}))
        else:
            return await super().fulfill(params)
        headers = [{"name":"Content-Type","value":"application/json"},
                   {"name":"Access-Control-Allow-Origin","value":"http://127.0.0.1:3000"},
                   {"name":"Access-Control-Allow-Credentials","value":"true"},
                   {"name":"Access-Control-Allow-Headers","value":"Content-Type,X-stackpilot-CSRF"},
                   {"name":"Access-Control-Allow-Methods","value":"GET,POST,PUT,DELETE,OPTIONS"}]
        await self.call("Fetch.fulfillRequest", dict(requestId=params["requestId"], responseCode=200,
            responseHeaders=headers, body=base64.b64encode(json.dumps(data).encode()).decode()))


MOCK = r"""
localStorage.setItem('theme','dark');
window.__browserAttachModes=[];window.__sandboxRPC=[];window.__sandboxMode=null;
class FixtureSocket extends EventTarget {
 static OPEN=1;static CLOSED=3;
 constructor(url){super();this.url=url;this.readyState=0;setTimeout(()=>{this.readyState=1;this.onopen?.({});},10);}
 send(raw){const msg=JSON.parse(raw);const reply=(value)=>this.onmessage?.({data:JSON.stringify(value)});
  if(this.url.includes('control_only=1')){
   window.__sandboxRPC.push(msg);
   setTimeout(()=>{
    if(msg.type==='switch_mode'){
     if(window.__failNextSwitch){window.__failNextSwitch=false;reply({type:'browser_error',message:'Worker unreachable fixture'});return;}
     window.__sandboxMode=msg.sandbox_mode;
    }
    reply({type:'browser_mode',browser_mode:window.__sandboxMode});
   },150);
  }else if(msg.type==='attach'){
   window.__browserAttachModes.push(msg.sandbox_mode);
   setTimeout(()=>{reply({type:'page_state',session_id:'a5ec02c3-ec55-4b50-925a-1e1eab5c01ae',url:'about:blank',title:'Owned QA',elements:[]});
    reply({type:'stream_capabilities',webrtc:false,browser_mode:msg.sandbox_mode});},20);
  }
 }
 close(){this.readyState=3;this.onclose?.({code:1000});}
}
window.WebSocket=FixtureSocket;
"""


async def main():
    config = browser_config("host")
    owner = await open_context_owner(config.endpoint, config.headers)
    context, target = await create_isolated_target(config.endpoint, owner, fullscreen=False)
    output = {}
    try:
        address = config.endpoint.replace("http://", "ws://") + "/devtools/page/" + target
        async with websockets.connect(address, additional_headers=config.headers, max_size=16*1024*1024) as socket:
            cdp = FrontendCDP(socket)
            await cdp.call("Page.enable")
            await cdp.call("Runtime.enable")
            await cdp.call("Fetch.enable",dict(patterns=[dict(urlPattern="*api/v1/*")]))
            await cdp.call("Page.addScriptToEvaluateOnNewDocument",dict(source=MOCK))
            started=time.monotonic()
            await cdp.call("Page.navigate",dict(url="http://127.0.0.1:3000/dashboard"))
            await wait_for(cdp,"!!document.querySelector('[data-slot=card-footer]')",30)
            output["projects_render_seconds"]=round(time.monotonic()-started,3)
            started=time.monotonic()
            await cdp.evaluate("document.querySelector('a[href=\"/dashboard/ai\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[aria-label=\"Agent settings\"]')",30)
            output["projects_to_ai_seconds"]=round(time.monotonic()-started,3)
            await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Live App').click()")
            await wait_for(cdp,"window.__browserAttachModes.length>0",30)
            await cdp.evaluate("document.querySelector('[aria-label=\"Agent settings\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[data-slot=dialog-content]')",10)
            initial_id=await cdp.evaluate("new URL(location.href).searchParams.get('session_id')")
            assert initial_id==SESSION,initial_id
            for label,mode in [("Remote","remote"),("Host Chrome","host"),("Local","local")]:
                await cdp.evaluate(f"[...document.querySelectorAll('[data-slot=dialog-content] button')].find(b=>b.textContent.trim()==={json.dumps(label)}).click()")
                await wait_for(cdp,f"window.__browserAttachModes.at(-1)==={json.dumps(mode)} && !document.querySelector('[aria-busy=true]')",10)
                assert await cdp.evaluate("new URL(location.href).searchParams.get('session_id')")==SESSION
            attach_count=await cdp.evaluate("window.__browserAttachModes.length")
            await cdp.evaluate("window.__failNextSwitch=true; [...document.querySelectorAll('[data-slot=dialog-content] button')].find(b=>b.textContent.trim()==='Remote').click()")
            await wait_for(cdp,"[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('Worker unreachable fixture'))",10)
            assert await cdp.evaluate("window.__browserAttachModes.length")==attach_count
            output.update(await cdp.evaluate("({attach_modes:window.__browserAttachModes,chat_id_unchanged:new URL(location.href).searchParams.get('session_id')==='a5ec02c3-ec55-4b50-925a-1e1eab5c01ae',failed_switch_kept_previous:window.__sandboxMode==='local',loaded_fonts:document.fonts.size,ready:document.readyState})"))
            await cdp.call("Input.dispatchKeyEvent",dict(type="keyDown",key="Escape",code="Escape",windowsVirtualKeyCode=27))
            await cdp.call("Input.dispatchKeyEvent",dict(type="keyUp",key="Escape",code="Escape",windowsVirtualKeyCode=27))
            await wait_for(cdp,"!document.querySelector('[data-slot=dialog-content]')",10)
            started=time.monotonic()
            await cdp.evaluate("document.querySelector('a[href=\"/dashboard\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[data-slot=card-footer]')",10)
            output["ai_to_projects_seconds"]=round(time.monotonic()-started,3)
            started=time.monotonic()
            await cdp.evaluate("document.querySelector('a[href=\"/dashboard/ai\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[aria-label=\"Agent settings\"]')",10)
            output["warm_projects_to_ai_seconds"]=round(time.monotonic()-started,3)
            output["page_errors"]=cdp.errors
            assert not cdp.errors,cdp.errors
            cdp.reader.cancel()
    finally:
        await dispose_context(config.endpoint,context,config.headers)
        await owner.close()
    Path("/tmp/frontend-startup-result.json").write_text(json.dumps(output,indent=2))
    print(json.dumps(output),flush=True)


asyncio.run(main())
