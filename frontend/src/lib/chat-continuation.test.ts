import { expect, it } from "vitest";
import { upsertChatMessage, joinContinuation, permissionRequestId } from "./chat-continuation";

it("keeps the same assistant id and preserves untouched history during streaming and approval",()=>{
  const user={id:"user",content:"Repair"};
  const assistant={id:"assistant",content:"Needs approval"};
  const updated=upsertChatMessage([user,assistant],{id:"assistant",content:joinContinuation("Inspected source.","Rebuild queued. Job `owned-job`.")});
  expect(updated).toHaveLength(2);
  expect(updated[0]).toBe(user);
  expect(updated[1]).toEqual({id:"assistant",content:"Inspected source.\n\nRebuild queued. Job `owned-job`."});
});

it("keeps an approval without an explicit event id stable across live and recovered events",()=>{
  const event={token:"private-parameters."+"a".repeat(64)};
  expect(permissionRequestId(event)).toBe("permission-"+"a".repeat(32));
  expect(permissionRequestId({...event})).toBe(permissionRequestId(event));
  expect(permissionRequestId({...event,id:"explicit-step"})).toBe("explicit-step");
  expect(permissionRequestId(event)).not.toContain("private-parameters");
});
