"""Build/run disposable Linux repositories through the generated real recipes.

No platform account/project is created, and no existing deployment is rebuilt.
Image selection alone is never recorded as passing execution qualification.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deployment-runtime'))
from planner import prepare


def docker(*argv, timeout=120):
    value = subprocess.run(['docker', *argv], capture_output=True, text=True, timeout=timeout)
    if value.returncode: raise RuntimeError(value.stderr[-6000:]+'\n'+value.stdout[-6000:])
    return value.stdout


def source(root, language):
    root.mkdir()
    config = {'workload': 'cli', 'tests_required': True}
    if language == 'python':
        (root/'.python-version').write_text('3.11\n')
        (root/'requirements.txt').write_text('')
        (root/'app.py').write_text('def add(a,b): return a+b\nif __name__ == "__main__":\n a,b=map(int,input("Numbers: ").split()); print("RESULT="+str(add(a,b)))\n')
        config.update(entrypoint=['python', '-u', 'app.py'], tests=[['python', '-c', 'from app import add; assert add(7,-2)==5; assert add(-3,-4)==-7']])
    elif language == 'node':
        (root/'.nvmrc').write_text('20\n')
        (root/'package.json').write_text(json.dumps({'name': 'stackpilot-toolchain-fixture', 'version': '1.0.0', 'engines': {'node': '>=20 <21'}, 'scripts': {'test': 'node test.cjs'}}))
        (root/'math.cjs').write_text('exports.add=(a,b)=>a+b;\n')
        (root/'test.cjs').write_text('const {add}=require("./math.cjs");const assert=require("node:assert/strict");assert.equal(add(7,-2),5);assert.equal(add(-3,-4),-7);\n')
        (root/'app.cjs').write_text('const rl=require("node:readline").createInterface({input:process.stdin});console.log("Numbers:");rl.once("line",line=>{let [a,b]=line.trim().split(/\\s+/).map(Number);console.log("RESULT="+require("./math.cjs").add(a,b));rl.close()});\n')
        config.update(entrypoint=['node', 'app.cjs'], tests=[['node', 'test.cjs']])
    elif language == 'go':
        (root/'go.mod').write_text('module example.com/stackpilot-fixture\ngo 1.24\n')
        (root/'main.go').write_text('package main\nimport "fmt"\nfunc add(a,b int)int{return a+b}\nfunc main(){var a,b int;fmt.Println("Numbers:");if _,err:=fmt.Scan(&a,&b);err!=nil{panic(err)};fmt.Printf("RESULT=%d\\n",add(a,b))}\n')
        (root/'main_test.go').write_text('package main\nimport "testing"\nfunc TestAdd(t *testing.T){if add(7,-2)!=5||add(-3,-4)!=-7{t.Fatal("arithmetic contract failed")}}\n')
        config.update(entrypoint=['/app/server'], tests=[['go', 'test', './...']])
    elif language == 'ruby':
        (root/'.ruby-version').write_text('3.3\n'); (root/'Gemfile').write_text('source "https://rubygems.org"\nruby "~> 3.3"\n')
        (root/'app.rb').write_text('def add(a,b); a+b; end\nif __FILE__ == $0\n puts "Numbers:"; a,b=STDIN.gets.split.map(&:to_i); puts "RESULT=#{add(a,b)}"\nend\n')
        config.update(entrypoint=['ruby', 'app.rb'], tests=[['ruby', '-r', './app.rb', '-e', 'raise "broken" unless add(7,-2)==5 && add(-3,-4)==-7']])
    elif language == 'java':
        (root/'.java-version').write_text('21\n')
        (root/'pom.xml').write_text('<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>')
        # The repository wrapper is an explicit executable build recipe; this
        # fixture invokes real javac/jar, not a canned artifact or test result.
        (root/'mvnw').write_text('#!/bin/sh\nset -eu\nmkdir -p target/classes\njavac -d target/classes Main.java\njava -cp target/classes Main --test\njar --create --file target/app.jar --main-class Main -C target/classes .\n')
        (root/'Main.java').write_text('import java.util.Scanner; public class Main { static int add(int a,int b){return a+b;} public static void main(String[]args){if(args.length>0){if(add(7,-2)!=5||add(-3,-4)!=-7)throw new IllegalStateException("broken");return;}System.out.println("Numbers:");Scanner s=new Scanner(System.in);System.out.println("RESULT="+add(s.nextInt(),s.nextInt()));}}')
        config.update(entrypoint=['java', '-jar', 'target/app.jar'], tests=[['java', '-cp', 'target/classes', 'Main', '--test']])
    else: raise ValueError('Unsupported smoke fixture: '+language)
    config['console_scenarios'] = [{'name': 'signed addition', 'steps': [{'output_contains': 'Numbers:'}, {'input': '7 -2\n', 'output_contains': 'RESULT=5'}, {'exit_code': 0}]}]
    (root/'stackpilot.json').write_text(json.dumps(config))
    return prepare(root, 'standard_web')


def call(base, path, payload=None):
    request = urllib.request.Request(base+path, data=json.dumps(payload).encode() if payload is not None else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=3) as response: return json.load(response)


def qualify(root, language):
    token = uuid.uuid4().hex
    tag, container = 'stackpilot-toolchain-qa:'+token, 'stackpilot-toolchain-qa-'+token
    record = {'language': language, 'passed': False}
    began = time.monotonic()
    try:
        contract = source(root, language); record['toolchain'] = contract['toolchain']
        docker('build', '--network=default', '--tag', tag, str(root), timeout=900)
        record['image_id'] = docker('image', 'inspect', '--format', '{{.Id}}', tag).strip()
        evidence = docker('create', '--name', container, '--network=bridge', '--memory=512m', '--cpus=1', '--pids-limit=128', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--publish', '127.0.0.1::3000', tag)
        docker('start', container)
        inspected = json.loads(docker('inspect', container))[0]
        port = inspected['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
        base = 'http://127.0.0.1:'+port
        until = time.monotonic()+30
        while True:
            try: health = call(base, '/healthz'); break
            except (OSError, urllib.error.URLError):
                if time.monotonic()>until: raise RuntimeError('Runtime did not become healthy: '+docker('logs', container))
                time.sleep(.2)
        opened = call(base, '/console/open', {}); session = opened['session_id']
        call(base, '/console/input', {'session_id': session, 'input': '7 -2\n'})
        until = time.monotonic()+10
        while True:
            outcome = call(base, '/console/read?session_id='+session+'&offset=0')
            if outcome.get('exit_code') is not None: break
            if time.monotonic()>until: raise RuntimeError('CLI did not finish: '+json.dumps(outcome))
            time.sleep(.1)
        if outcome['exit_code'] != 0 or 'RESULT=5' not in outcome['output']: raise RuntimeError('Actual CLI behavior failed: '+json.dumps(outcome))
        tests = docker('exec', container, 'cat', '/app/.stackpilot-tests.json' if language in {'node','python','java','ruby'} else '/stackpilot-evidence/tests.json')
        record.update(passed=True, tests=json.loads(tests), console=outcome, health=health)
    except Exception as exc:
        record['error'] = str(exc)[-10000:]
    finally:
        subprocess.run(['docker', 'rm', '-f', container], capture_output=True, timeout=30)
        subprocess.run(['docker', 'image', 'rm', tag], capture_output=True, timeout=30)
        record['duration_seconds'] = round(time.monotonic()-began, 2)
    return record


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--languages', default='python,node,go'); parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    cases = []
    with tempfile.TemporaryDirectory(prefix='stackpilot-toolchain-qa-') as temporary:
        for language in args.languages.split(','):
            print('Qualifying actual '+language+' Docker build/runtime', flush=True)
            cases.append(qualify(Path(temporary)/language, language))
            print(json.dumps({'language': language, 'passed': cases[-1]['passed'], 'duration_seconds': cases[-1]['duration_seconds']}), flush=True)
    result = {'scope': 'real Docker build, repository tests and interactive CLI execution; no autonomous-model or universal-compatibility claim', 'passed': all(c['passed'] for c in cases), 'cases': cases}
    if args.output: args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
