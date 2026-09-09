import subprocess,json,urllib.request,time,pathlib,hashlib
image='registry.k8s.io/e2e-test-images/agnhost:2.47@sha256:cc249acbd34692826b2b335335615e060fdb3c0bca4954507aa3a1d1194de253'
def docker(*args):return subprocess.check_output(['docker',*args],text=True).strip()
info=json.loads(docker('image','inspect',image))[0]
receipt={'scope':'single-local-container-not-kubernetes','image':image,'imageId':info['Id'],'os':info['Os'],'architecture':info['Architecture'],'entrypoint':info['Config']['Entrypoint'],'defaultCmd':info['Config']['Cmd'],'runs':[]}
for args in [[],['serve-hostname','--http=true','--port=8080']]:
 cid=docker('run','--detach','--rm','--publish','127.0.0.1::8080',image,*args)
 record={'args':args,'httpStatus':None,'response':None,'cleanup':False}
 try:
  endpoint='http://'+docker('port',cid,'8080/tcp')+'/'
  for attempt in range(5):
   try:
    with urllib.request.urlopen(endpoint,timeout=1) as response:
     record['httpStatus']=response.status;record['response']=response.read().decode();break
   except Exception: time.sleep(.2)
 finally:
  docker('stop','--time','1',cid)
  for attempt in range(20):
   record['cleanup']=subprocess.run(['docker','container','inspect',cid],capture_output=True).returncode!=0
   if record['cleanup']: break
   time.sleep(.1)
 receipt['runs'].append(record)
assert receipt['runs'][0]['httpStatus'] is None
assert receipt['runs'][1]['httpStatus']==200 and receipt['runs'][1]['response'].strip()
assert all(r['cleanup'] for r in receipt['runs'])
source=pathlib.Path('apps/shop-web-kubara.yaml').read_bytes()
receipt['appSha256']=hashlib.sha256(source).hexdigest()
p=pathlib.Path('proofs/shop-http-2026-09-09');p.mkdir(parents=True,exist_ok=True)
p.joinpath('receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
