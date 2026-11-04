import { familyOf, type ConnectorProvider } from "../../shared/connectors";
import { azureAdapter } from "./azure";
import { confluenceAdapter } from "./confluence";
import { githubAdapter } from "./github";
import { gitlabAdapter } from "./gitlab";
import { jiraAdapter } from "./jira";
import { linearAdapter } from "./linear";
import type { ConnectorAdapter } from "./types";

const adapters = { jira: jiraAdapter, confluence: confluenceAdapter, github: githubAdapter, gitlab: gitlabAdapter, azure: azureAdapter, linear: linearAdapter } as const;

export const adapterFor = (provider: ConnectorProvider): ConnectorAdapter => adapters[familyOf(provider)];
