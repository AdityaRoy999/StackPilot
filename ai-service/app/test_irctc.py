import asyncio
from app.browser_driver import BrowserDriver
from app.apv_engine import ActionPerceptionVerification

async def main():
    apv = ActionPerceptionVerification('abc')
    driver = BrowserDriver(apv)
    sess = await driver.open_live_session('https://www.irctc.co.in/nget/train-search')
    await asyncio.sleep(5)
    
    tree = await driver.apv.extract_interactive_tree(sess)
    for el in tree:
        text = str(el.get('text') or '')
        aria = str(el.get('aria_label') or '')
        ph = str(el.get('placeholder') or '')
        name = str(el.get('name') or '')
        eid = str(el.get('id') or '')
        
        if 'from' in text.lower() or 'from' in aria.lower() or 'from' in ph.lower() or 'from' in name.lower() or 'from' in eid.lower() or \
           'to' in text.lower() or 'to' in aria.lower() or 'to' in ph.lower() or 'to' in name.lower() or 'to' in eid.lower():
            print(f"FOUND: id={el.get('id')} tag={el.get('tag')} class={el.get('classes')} role={el.get('role')} type={el.get('type')}")
            print(f"  text: {text}")
            print(f"  aria: {aria}")
            print(f"  placeholder: {ph}")
            print(f"  name: {name}")
            print(f"  eid: {eid}")
    
    await driver.close_session(sess.session_id)

asyncio.run(main())
