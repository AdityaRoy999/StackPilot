"""Bound failures by operation, independent of changing text or element IDs."""
import hashlib
import json

from ..testing_runtime import action_status


class OperationRecovery:
    def __init__(self): self.failures={};self.readbacks={}

    def key(self,session,args):
        action=args.get('action')
        if action not in {'type','click','choose_option','choose_date'}: return None
        ref=args.get('element_id')
        matches=[e for e in getattr(session,'interactive_elements',[]) if e.get('id')==ref]
        if len(matches)!=1: return None
        control=matches[0]
        identity={k:control.get(k) for k in ('tag','role','name','input_id','placeholder','editor_kind')}
        if not any(identity.get(k) for k in ('name','input_id','placeholder','editor_kind')): identity['id']=ref
        return hashlib.sha256(json.dumps([session.current_url,action,identity],sort_keys=True).encode()).hexdigest()

    def blocked(self,session,args):
        key=self.key(session,args)
        if key and self.failures.get(key,0)>=2 and not self.readbacks.pop(key,False):
            return {'status':'failed','action':args.get('action'),'error':'This operation failed repeatedly even when its arguments changed. No input dispatched. Preserve the original task; read the editor document or inspect a different current target before changing strategy.',
                    'recovery':{'reason':'repeated_operation','requires_fresh_readback':True}}
        return None

    def record(self,session,args,result):
        if (result.get('recovery') or {}).get('reason')=='repeated_operation': return
        key=self.key(session,args)
        if key:
            if action_status(result)=='passed': self.failures.pop(key,None)
            else: self.failures[key]=self.failures.get(key,0)+1

    def editor_readback(self,session,ref):
        key=self.key(session,{'action':'type','element_id':ref})
        # One further native replacement may follow a readback, but never an
        # endless read/type loop. Other targets and observations remain usable.
        if key and self.failures.get(key,0)==2: self.readbacks[key]=True
