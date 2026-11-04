import { describe, expect, test } from "vitest";
import {
  classifyQuery,
  externalTarget,
  faceKey,
  githubFromUrl,
  gitlabFromUrl,
  issueKey,
  itemLabel,
  itemUrl,
  jqlKeys,
  linkedCardCounts,
  keyFromUrl,
  normalizeBaseUrl,
  numberCandidates,
  pageFromUrl,
  parseKey,
  quotedText,
  recognizeUrl,
  remoteRepo,
  tinyLinkId,
} from "./connectors";

const dc = { id: "dc", provider: "jira-dc" as const, baseUrl: "https://jira.example.com" };
const cloud = { id: "cloud", provider: "jira-cloud" as const, baseUrl: "https://team.atlassian.net" };
const sub = { id: "sub", provider: "jira-dc" as const, baseUrl: "https://tools.example.com/jira" };
const wiki = { id: "wiki", provider: "confluence-dc" as const, baseUrl: "https://confluence.example.com" };
const wikiCloud = { id: "wc", provider: "confluence-cloud" as const, baseUrl: "https://team.atlassian.net/wiki" };
const gh = { id: "gh", provider: "github" as const, baseUrl: "https://github.com" };
const gl = { id: "gl", provider: "gitlab" as const, baseUrl: "https://git.example.com" };

describe("Jira links and keys (EXTERNAL-TRACKER-SPEC §3.1)", () => {
  test("keys are normalized and anything else is not a key", () => {
    expect(issueKey(" shopsr-123 ")).toBe("SHOPSR-123");
    expect(issueKey("AB_1-9")).toBe("AB_1-9");
    expect(issueKey("123")).toBeNull();
    expect(issueKey("SHOPSR-12a")).toBeNull();
    expect(issueKey("x) OR key = Y-1")).toBeNull();
  });

  test("browse links, board links with selectedIssue, context paths; other hosts and paths do not match", () => {
    expect(keyFromUrl("https://jira.example.com/browse/SHOPSR-123", dc.baseUrl)).toBe("SHOPSR-123");
    expect(keyFromUrl("https://JIRA.example.com/browse/shopsr-7?focusedCommentId=1#c", dc.baseUrl)).toBe("SHOPSR-7");
    expect(keyFromUrl("https://jira.example.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=AB-2", dc.baseUrl)).toBe("AB-2");
    expect(keyFromUrl("https://tools.example.com/jira/browse/AB-3", sub.baseUrl)).toBe("AB-3");
    expect(keyFromUrl("https://tools.example.com/other/browse/AB-3", sub.baseUrl)).toBeNull();
    expect(keyFromUrl("https://evil.example.org/browse/AB-3", dc.baseUrl)).toBeNull();
    expect(keyFromUrl("https://jira.example.com/projects/AB", dc.baseUrl)).toBeNull();
  });

  test("a bare key needs exactly one connection that accepts it; a link picks its own", () => {
    expect(externalTarget("AB-1", [dc])).toEqual({ connectionId: "dc", itemType: "issue", key: "AB-1" });
    expect(externalTarget("AB-1", [dc, cloud])).toBeNull();
    // GitHub and Confluence don't read "AB-1", so the Jira connection is the only taker.
    expect(externalTarget("AB-1", [dc, gh, wiki])).toEqual({ connectionId: "dc", itemType: "issue", key: "AB-1" });
    expect(externalTarget("https://team.atlassian.net/browse/AB-1", [dc, cloud])).toEqual({ connectionId: "cloud", itemType: "issue", key: "AB-1" });
    expect(externalTarget("https://github.com/a/b/issues/1", [dc])).toBeNull();
    expect(externalTarget("docs/spec.md", [dc])).toBeNull();
  });

  test("base URLs keep the context path and drop credentials and trailing slashes", () => {
    expect(normalizeBaseUrl("https://jira.example.com/")).toBe("https://jira.example.com");
    expect(normalizeBaseUrl("https://tools.example.com/jira//")).toBe("https://tools.example.com/jira");
    expect(normalizeBaseUrl("https://u:p@jira.example.com")).toBeNull();
    expect(normalizeBaseUrl("ftp://jira.example.com")).toBeNull();
    expect(normalizeBaseUrl("jira")).toBeNull();
  });
});

describe("Confluence pages (CONNECTORS-SPEC §7)", () => {
  test("viewpage, /spaces/…/pages/<id>, /display/<space>/<title> and tiny links", () => {
    expect(pageFromUrl("https://confluence.example.com/pages/viewpage.action?pageId=123456", wiki.baseUrl)).toEqual({ id: "123456" });
    expect(pageFromUrl("https://team.atlassian.net/wiki/spaces/ENG/pages/98765/Search+design#section", wikiCloud.baseUrl)).toEqual({ id: "98765" });
    expect(pageFromUrl("https://team.atlassian.net/wiki/spaces/ENG/pages/edit-v2/98765", wikiCloud.baseUrl)).toEqual({ id: "98765" });
    expect(pageFromUrl("https://confluence.example.com/display/ENG/Search+Design%20Notes", wiki.baseUrl)).toEqual({ space: "ENG", title: "Search Design Notes" });
    expect(pageFromUrl("https://confluence.example.com/x/CwBW", wiki.baseUrl)).toEqual({ id: "5636107" });
    expect(pageFromUrl("https://confluence.example.com/pages/viewpage.action?pageId=abc", wiki.baseUrl)).toBeNull();
    expect(pageFromUrl("https://team.atlassian.net/spaces/ENG/pages/1", wikiCloud.baseUrl)).toBeNull();
    expect(pageFromUrl("https://other.example.com/pages/viewpage.action?pageId=1", wiki.baseUrl)).toBeNull();
  });

  test("tiny link codes decode to page ids without a request", () => {
    expect(tinyLinkId("AgAB")).toBe("65538");
    expect(tinyLinkId("Fc1bBw")).toBe("123456789");
    expect(tinyLinkId("ewAAAPQB")).toBe("2147483648123");
    expect(tinyLinkId("")).toBeNull();
    expect(tinyLinkId("bad!")).toBeNull();
  });

  test("a bare page id is a key only for Confluence; pages have no card-face key", () => {
    expect(parseKey("123456", "confluence-dc")).toEqual({ itemType: "page", key: "123456" });
    expect(parseKey("123456", "jira-dc")).toBeNull();
    expect(externalTarget("123456", [dc, wiki])).toEqual({ connectionId: "wiki", itemType: "page", key: "123456" });
    expect(itemUrl(wikiCloud, "page", "98765")).toBe("https://team.atlassian.net/wiki/pages/viewpage.action?pageId=98765");
    expect(faceKey({ key: "98765", itemType: "page" })).toBeNull();
  });
});

describe("GitHub and GitLab items (CONNECTORS-SPEC §5, §6)", () => {
  test("GitHub issue and pull links with subpages; other paths are not items", () => {
    expect(githubFromUrl("https://github.com/acme/web/issues/12", gh.baseUrl)).toEqual({ itemType: "issue", key: "acme/web#12" });
    expect(githubFromUrl("https://github.com/acme/web/pull/34/files#diff-1", gh.baseUrl)).toEqual({ itemType: "pull", key: "acme/web#34" });
    expect(githubFromUrl("https://github.com/acme/web/blob/main/README.md", gh.baseUrl)).toBeNull();
    expect(githubFromUrl("https://github.com/acme/web/issues", gh.baseUrl)).toBeNull();
    expect(githubFromUrl("https://gitlab.com/acme/web/issues/12", gh.baseUrl)).toBeNull();
  });

  test("GitLab issue, work item and merge request links, nested groups and subpages", () => {
    expect(gitlabFromUrl("https://git.example.com/shopee/search/bff/-/merge_requests/345/diffs?commit_id=x", gl.baseUrl)).toEqual({
      itemType: "merge_request",
      key: "shopee/search/bff!345",
    });
    expect(gitlabFromUrl("https://git.example.com/team/app/-/issues/7#note_1", gl.baseUrl)).toEqual({ itemType: "issue", key: "team/app#7" });
    expect(gitlabFromUrl("https://git.example.com/team/app/-/work_items/8", gl.baseUrl)).toEqual({ itemType: "issue", key: "team/app#8" });
    expect(gitlabFromUrl("https://git.example.com/team/app/-/tree/main", gl.baseUrl)).toBeNull();
    expect(gitlabFromUrl("https://git.example.com/../-/issues/1", gl.baseUrl)).toBeNull();
  });

  test("bare keys: # for issues, ! for merge requests (GitLab only); ambiguity across services refuses", () => {
    expect(parseKey("acme/web#12", "github")).toEqual({ itemType: "issue", key: "acme/web#12" });
    expect(parseKey("acme/web!12", "github")).toBeNull();
    expect(parseKey("team/app!34", "gitlab")).toEqual({ itemType: "merge_request", key: "team/app!34" });
    expect(parseKey("a b#1", "gitlab")).toBeNull();
    expect(externalTarget("acme/web#12", [gh, gl])).toBeNull();
    expect(externalTarget("team/app!34", [gh, gl])).toEqual({ connectionId: "gl", itemType: "merge_request", key: "team/app!34" });
    expect(itemUrl(gl, "merge_request", "team/app!34")).toBe("https://git.example.com/team/app/-/merge_requests/34");
    expect(itemUrl(gh, "pull", "acme/web#5")).toBe("https://github.com/acme/web/pull/5");
  });

  test("card-face keys keep the repository name only", () => {
    expect(faceKey({ key: "shopee/search/bff!345", itemType: "merge_request" })).toBe("bff!345");
    expect(faceKey({ key: "acme/web#12", itemType: "pull" })).toBe("web#12");
    expect(faceKey({ key: "AB-1" })).toBe("AB-1");
  });

  test("git remotes on the connection's host become repositories; other hosts are ignored", () => {
    expect(remoteRepo("git@github.com:acme/web.git", gh.baseUrl)).toBe("acme/web");
    expect(remoteRepo("https://github.com/acme/web", gh.baseUrl)).toBe("acme/web");
    expect(remoteRepo("ssh://git@git.example.com:2222/shopee/search/bff.git", gl.baseUrl)).toBe("shopee/search/bff");
    expect(remoteRepo("gitlab@git.example.com:team/app.git", gl.baseUrl)).toBe("team/app");
    expect(remoteRepo("git@github.com:acme/web.git", gl.baseUrl)).toBeNull();
    expect(remoteRepo("https://tools.example.com/gitlab/team/app.git", "https://tools.example.com/gitlab")).toBe("team/app");
  });

  test("agent-facing labels", () => {
    expect(itemLabel("gitlab", "merge_request")).toBe("GitLab merge request");
    expect(itemLabel("github", "pull")).toBe("GitHub pull request");
    expect(itemLabel("confluence-cloud", "page")).toBe("Confluence page");
    expect(itemLabel("jira-dc", "issue")).toBe("Jira ticket");
  });
});

describe("picker queries (EXTERNAL-TRACKER-SPEC §5.2)", () => {
  test("Jira: empty, key, link, number and text", () => {
    expect(classifyQuery("  ", dc)).toEqual({ kind: "recent" });
    expect(classifyQuery("shopsr-1", dc)).toEqual({ kind: "key", itemType: "issue", key: "SHOPSR-1" });
    expect(classifyQuery("https://jira.example.com/browse/AB-9", dc)).toEqual({ kind: "key", itemType: "issue", key: "AB-9" });
    expect(classifyQuery("#123", dc)).toEqual({ kind: "number", number: "123", sep: "#" });
    expect(classifyQuery("empty result page", dc)).toEqual({ kind: "text", text: "empty result page" });
  });

  test("other services: numbers with # and !, display links, page ids", () => {
    expect(classifyQuery("!34", gl)).toEqual({ kind: "number", number: "34", sep: "!" });
    expect(classifyQuery("!34", gh)).toEqual({ kind: "text", text: "!34" });
    expect(classifyQuery("12", gh)).toEqual({ kind: "number", number: "12" });
    expect(classifyQuery("https://confluence.example.com/display/ENG/Plan", wiki)).toEqual({ kind: "lookup", space: "ENG", title: "Plan" });
    expect(classifyQuery("4242", wiki)).toEqual({ kind: "key", itemType: "page", key: "4242" });
  });

  test("a number is tried in the projects of my recent tickets, most recent first", () => {
    expect(numberCandidates("12", [{ key: "B-1" }, { key: "A-2" }, { key: "B-3" }])).toEqual(["B-12", "A-12"]);
    expect(numberCandidates("12", [])).toEqual([]);
  });

  test("user text is a single escaped JQL/CQL string literal", () => {
    expect(quotedText('say "hi"')).toBe('"say hi"');
    expect(quotedText('a" OR project = X OR summary ~ "b')).toBe('"a OR project = X OR summary b"');
    expect(quotedText("back\\slash (x) [y] *z? a:b")).toBe('"back slash x y z a b"');
    expect(quotedText("中文 标题")).toBe('"中文 标题"');
  });

  test("key lists only ever contain validated keys", () => {
    expect(jqlKeys(["ab-1", "B-2"])).toBe("key in (AB-1, B-2)");
    expect(jqlKeys(["A-1) OR (1=1", "x"])).toBeNull();
    expect(jqlKeys([])).toBeNull();
  });
});

describe("Azure DevOps keys and links", () => {
  const az = { id: "az", provider: "azure-devops" as const, baseUrl: "https://dev.azure.com/acme" };
  test("work item links with or without a project, board pages, Server collections and legacy hosts", () => {
    expect(recognizeUrl("https://dev.azure.com/acme/Search%20App/_workitems/edit/4821", az)).toEqual({ itemType: "issue", key: "AB#4821" });
    expect(recognizeUrl("https://dev.azure.com/acme/_workitems/edit/4821/", az)).toEqual({ itemType: "issue", key: "AB#4821" });
    expect(recognizeUrl("https://dev.azure.com/acme/App/_boards/board/t/Team/Stories?workitem=17", az)).toEqual({ itemType: "issue", key: "AB#17" });
    expect(recognizeUrl("https://dev.azure.com/other/App/_workitems/edit/4821", az)).toBeNull();
    expect(recognizeUrl("https://dev.azure.com/acme/App/_git/repo/pullrequest/5", az)).toBeNull();
    const server = { provider: "azure-devops" as const, baseUrl: "https://tfs.example.com/tfs/Main" };
    expect(recognizeUrl("https://tfs.example.com/tfs/Main/App/_workitems/edit/9", server)).toEqual({ itemType: "issue", key: "AB#9" });
    const legacy = { provider: "azure-devops" as const, baseUrl: "https://acme.visualstudio.com" };
    expect(recognizeUrl("https://acme.visualstudio.com/App/_workitems/edit/9", legacy)).toEqual({ itemType: "issue", key: "AB#9" });
  });
  test("AB# keys, picker queries, urls and labels", () => {
    expect(parseKey("ab#12", "azure-devops")).toEqual({ itemType: "issue", key: "AB#12" });
    expect(parseKey("12", "azure-devops")).toBeNull();
    expect(parseKey("AB#12", "gitlab")).toBeNull();
    expect(classifyQuery("#12", az)).toEqual({ kind: "key", itemType: "issue", key: "AB#12" });
    expect(classifyQuery("12", az)).toEqual({ kind: "key", itemType: "issue", key: "AB#12" });
    expect(classifyQuery("crash on start", az)).toEqual({ kind: "text", text: "crash on start" });
    expect(itemUrl(az, "issue", "AB#12")).toBe("https://dev.azure.com/acme/_workitems/edit/12");
    expect(faceKey({ key: "AB#12", itemType: "issue" })).toBe("AB#12");
    expect(itemLabel("azure-devops", "issue")).toBe("Azure DevOps work item");
    expect(externalTarget("AB#12", [az])).toMatchObject({ connectionId: "az", key: "AB#12" });
  });
});

test("linkedCardCounts counts each card once per connection, by connection id or a URL the connection recognizes", () => {
  const conn = (id: string, provider: "github" | "jira-dc", baseUrl: string) => ({ id, provider, name: id, baseUrl, account: "", verifiedAt: "", authFailed: false });
  const gh = conn("gh", "github", "https://github.com"), jira = conn("jira", "jira-dc", "https://jira.example.com");
  const ext = { connectionId: "gh", provider: "github" } as const;
  expect(linkedCardCounts([gh, jira], [
    { taskId: "a", target: "https://github.com/o/r/pull/1", external: ext },
    { taskId: "a", target: "https://github.com/o/r/pull/2", external: ext },
    { taskId: "b", target: "https://github.com/o/r/issues/3", external: { connectionId: "removed", provider: "github" } },
    { taskId: "c", target: "https://github.com/o/r/pull/4" },
  ])).toEqual({ gh: 2, jira: 0 });
});

describe("Linear keys and links (CONNECTORS-SPEC §14)", () => {
  const linear = { id: "lin", provider: "linear" as const, baseUrl: "https://linear.app/acme" };
  test("issue links below the workspace, with slugs, subpages and anchors; other workspaces and pages are not issues", () => {
    expect(recognizeUrl("https://linear.app/acme/issue/ENG-42", linear)).toEqual({ itemType: "issue", key: "ENG-42" });
    expect(recognizeUrl("https://linear.app/acme/issue/eng-42/fix-the-login-retry", linear)).toEqual({ itemType: "issue", key: "ENG-42" });
    expect(recognizeUrl("https://linear.app/acme/issue/ENG-42/fix-login#comment-1a2b3c", linear)).toEqual({ itemType: "issue", key: "ENG-42" });
    expect(recognizeUrl("https://linear.app/other/issue/ENG-42/fix-login", linear)).toBeNull();
    expect(recognizeUrl("https://linear.app/acme/project/checkout-0c7f", linear)).toBeNull();
    expect(recognizeUrl("https://linear.app/acme/team/ENG/active", linear)).toBeNull();
    expect(recognizeUrl("https://linear.app/acme/issue/not-a-key", linear)).toBeNull();
  });
  test("keys, picker queries, urls, face keys and labels", () => {
    expect(parseKey("eng-42", "linear")).toEqual({ itemType: "issue", key: "ENG-42" });
    expect(parseKey("42", "linear")).toBeNull();
    expect(classifyQuery("ENG-42", linear)).toEqual({ kind: "key", itemType: "issue", key: "ENG-42" });
    expect(classifyQuery("https://linear.app/acme/issue/ENG-42/x", linear)).toEqual({ kind: "key", itemType: "issue", key: "ENG-42" });
    // Numbers repeat across teams, so a bare number is a number search, as in Jira.
    expect(classifyQuery("42", linear)).toEqual({ kind: "number", number: "42" });
    expect(classifyQuery("login retry", linear)).toEqual({ kind: "text", text: "login retry" });
    expect(itemUrl(linear, "issue", "ENG-42")).toBe("https://linear.app/acme/issue/ENG-42");
    expect(faceKey({ key: "ENG-42", itemType: "issue" })).toBe("ENG-42");
    expect(itemLabel("linear", "issue")).toBe("Linear issue");
  });
  test("a bare key is ambiguous next to a Jira connection; a link is not", () => {
    expect(externalTarget("ENG-42", [linear])).toMatchObject({ connectionId: "lin", key: "ENG-42" });
    expect(externalTarget("ENG-42", [linear, dc])).toBeNull();
    expect(externalTarget("https://linear.app/acme/issue/ENG-42", [dc, linear])).toMatchObject({ connectionId: "lin", key: "ENG-42" });
  });
});
