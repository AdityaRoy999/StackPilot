import sys
sys.path.append("/app")
import asyncio
from app.browser_driver import browser_manager

async def main():
    sess = await browser_manager.get_or_create_session(session_id='test', url='https://www.irctc.co.in/nget/train-search')
    await asyncio.sleep(5)
    
    await sess.extract_interactive_tree()
    tree = sess.interactive_elements
    for el in tree:
        if isinstance(el, dict):
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
                print(f"  card_context: {el.get('card_context')}")
                print(f"  FULL DICT: {el}")
    
    await browser_manager.close_session('test')

asyncio.run(main())
