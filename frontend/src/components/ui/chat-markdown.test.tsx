import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./chat-markdown";
import { PermissionsPanel } from "./permissions-panel";

it("renders saved context headings, fenced code and lists safely",()=>{
  const html=renderToStaticMarkup(<ChatMarkdown content={'**Next step**\n\n- Verify the job\n\n```json\n{"job_id":"owned"}\n```\n\n<script>alert(1)</script>'} />);
  expect(html).toContain('<strong>Next step</strong>');
  expect(html).toContain('<li>Verify the job</li>');
  expect(html).toContain('language-json');
  expect(html).not.toContain('<script>');
});

it("shows a compact neutral permission section with reviewable details and explicit controls",()=>{
  const html=renderToStaticMarkup(<PermissionsPanel permissions={[{id:'owned-step',title:'workspace_trigger_rebuild',arguments:{deployment_id:'owned'},status:'pending'}]} pendingId="owned-step" />);
  expect(html).toContain('data-permissions-section');
  expect(html).toContain('Approve &amp; continue');
  expect(html).toContain('Decline');
  expect(html).not.toContain('amber');
  expect(html).not.toContain('orange');
});
