// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AccountControl } from "./AccountControl";
import { AuthClient } from "../../local";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function clientWith(responses: Record<string, Response>): AuthClient {
  return new AuthClient(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    return responses[key] ?? new Response(null, { status: 404 });
  });
}

describe("AccountControl", () => {
  it("registers an account and reports it to the workspace", async () => {
    const user = userEvent.setup();
    // #given
    const client = clientWith({
      "GET /api/me": new Response(null, { status: 401 }),
      "POST /api/auth/register": Response.json({ user: { id: "user_0001", username: "field.owner", name: null } }),
    });
    const changes: Array<string | null> = [];
    render(<AccountControl client={client} onAccountChange={(account) => changes.push(account?.username ?? null)} />);

    // #when
    await user.click(await screen.findByRole("button", { name: "계정 로그인" }));
    await user.click(screen.getByRole("button", { name: "회원가입" }));
    await user.type(screen.getByLabelText("아이디"), "field.owner");
    await user.type(screen.getByLabelText("비밀번호"), "measure-tape-2026");
    await user.click(screen.getByRole("button", { name: "가입하고 시작" }));

    // #then
    await waitFor(() => expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy());
    expect(screen.getByText("field.owner")).toBeTruthy();
    expect(changes).toEqual(["field.owner"]);
  });

  it("keeps the form open and explains why the server refused", async () => {
    const user = userEvent.setup();
    // #given
    const client = clientWith({
      "GET /api/me": new Response(null, { status: 401 }),
      "POST /api/auth/login": new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    render(<AccountControl client={client} />);

    // #when
    await user.click(await screen.findByRole("button", { name: "계정 로그인" }));
    await user.type(screen.getByLabelText("아이디"), "field.owner");
    await user.type(screen.getByLabelText("비밀번호"), "wrong-password-here");
    await user.click(screen.getByRole("button", { name: "로그인하고 동기화" }));

    // #then
    expect((await screen.findByRole("alert")).textContent).toContain("아이디 또는 비밀번호가 맞지 않습니다.");
    expect(screen.getByLabelText("아이디")).toBeTruthy();
  });

  it("refuses a too-short password before it ever reaches the network", async () => {
    const user = userEvent.setup();
    // #given
    let calls = 0;
    const client = new AuthClient(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/me")) return new Response(null, { status: 401 });
      calls += 1;
      return Response.json({ user: { id: "user_0001", username: "field.owner", name: null } });
    });
    render(<AccountControl client={client} />);

    // #when
    await user.click(await screen.findByRole("button", { name: "계정 로그인" }));
    await user.click(screen.getByRole("button", { name: "회원가입" }));
    await user.type(screen.getByLabelText("아이디"), "field.owner");
    await user.type(screen.getByLabelText("비밀번호"), "short");
    await user.click(screen.getByRole("button", { name: "가입하고 시작" }));

    // #then
    expect((await screen.findByRole("alert")).textContent).toContain("비밀번호는 10자 이상");
    expect(calls).toBe(0);
  });

  it("shows the signed-in account straight away when the session cookie is still valid", async () => {
    // #given
    const client = clientWith({
      "GET /api/me": Response.json({ user: { id: "user_0001", username: "returning.owner", name: null } }),
    });

    // #when
    render(<AccountControl client={client} />);

    // #then
    expect(await screen.findByText("returning.owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
  });
});
