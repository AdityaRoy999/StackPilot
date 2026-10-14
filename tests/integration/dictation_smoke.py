"""Live speech and UI qualification with disposable users and synthesized audio."""
import base64
import copy
import json
from pathlib import Path
import secrets
import subprocess
from urllib.parse import unquote
import uuid
import wave
import release_pipeline_smoke as release


def main():
    users=[];speech=None
    try:
        release.api('POST','/ai/dictation',{'action':'start'},expected=(401,))
        owner_cookies=None
        for suffix in ['owner','other']:
            name='dictation-'+suffix+'-'+uuid.uuid4().hex[:10]
            release.cookies.clear()
            release.api('POST','/auth/register',{'username':name,'email':name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
            users.append(str(uuid.UUID(release.api('GET','/auth/me')['user']['id'])))
            if suffix=='owner':owner_cookies=copy.deepcopy(list(release.cookies))
        saved_other=copy.deepcopy(list(release.cookies))
        release.cookies.clear()
        for cookie in owner_cookies:release.cookies.set_cookie(cookie)
        # C++ must bind ownership itself even if an untrusted caller supplies an ID.
        speech=release.api('POST','/ai/dictation',{'action':'start','sample_rate':16000,'user_id':users[1]})['session_id']
        waveform=wave.open(str(Path('tests/artifacts/dictation-fixture.wav')))
        sequence=0;partials=[]
        while chunk:=waveform.readframes(4000):
            result=release.api('POST','/ai/dictation',{'action':'audio','session_id':speech,'sequence':sequence,'pcm':base64.b64encode(chunk).decode()})
            if result['text']:partials.append(result['text'])
            # A retried chunk must return the same acknowledgement, not repeat words.
            if sequence==0:assert release.api('POST','/ai/dictation',{'action':'audio','session_id':speech,'sequence':sequence,'pcm':base64.b64encode(chunk).decode()})==result
            sequence=result['sequence']
        release.cookies.clear()
        # Use the second account's cookie captured by registration above.
        # owner cookies are restored explicitly after the cross-account assertion.
        for cookie in saved_other:release.cookies.set_cookie(cookie)
        release.api('POST','/ai/dictation',{'action':'stop','session_id':speech},expected=(404,))
        release.cookies.clear()
        for cookie in owner_cookies:release.cookies.set_cookie(cookie)
        result=release.api('POST','/ai/dictation',{'action':'stop','session_id':speech})
        assert result['text']=='check the deployment status and open the project logs',result
        assert partials and partials[0]!=result['text'],'Speech must be visible before finalization'
        assert release.api('POST','/ai/dictation',{'action':'stop','session_id':speech})==result
        speech=None
        token=unquote(next(cookie.value for cookie in release.cookies if cookie.name=='token'))
        runtime='C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        subprocess.run([runtime,'tests/integration/agent_composer_ui.mjs'],input=json.dumps({'token':token}),text=True,check=True)
        print('DICTATION_API_PASS: real partial/final recognition, authentication, owner binding, cross-user denial, retry deduplication')
    finally:
        if speech:
            release.cookies.clear()
            for cookie in owner_cookies:release.cookies.set_cookie(cookie)
            release.api('POST','/ai/dictation',{'action':'cancel','session_id':speech},expected=(200,404))
        for user in users:
            sql="DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='"+user+"' AND role='owner'); DELETE FROM users WHERE id='"+user+"';"
            subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],input=sql,text=True,check=True,capture_output=True)


if __name__=='__main__':main()
