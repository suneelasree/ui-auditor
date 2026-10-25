// Reads export target configuration from the environment. Values never leave the server.

export type ExportTarget = 'github' | 'jira';

export interface GithubConfig {
  token: string;
  repo: string;
  apiUrl: string;
}

export interface JiraEnvConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  /** Some Jira projects reject `priority` on create; JIRA_SET_PRIORITY=false leaves it out. */
  setPriority: boolean;
}

export function githubConfig(env: NodeJS.ProcessEnv): GithubConfig | undefined {
  const token = env.GITHUB_TOKEN?.trim();
  const repo = env.GITHUB_REPO?.trim();
  if (!token || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return undefined;
  return { token, repo, apiUrl: (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, '') };
}

export function jiraConfig(env: NodeJS.ProcessEnv): JiraEnvConfig | undefined {
  const baseUrl = env.JIRA_BASE_URL?.trim();
  const email = env.JIRA_EMAIL?.trim();
  const apiToken = env.JIRA_API_TOKEN?.trim();
  const projectKey = env.JIRA_PROJECT_KEY?.trim();
  if (!baseUrl || !email || !apiToken || !projectKey) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, apiToken, projectKey, issueType: env.JIRA_ISSUE_TYPE?.trim() || 'Bug', setPriority: env.JIRA_SET_PRIORITY?.trim().toLowerCase() !== 'false' };
}

/** Remove any configured secret values from a string (e.g. an upstream error body). */
export function scrubSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const v of [env.GITHUB_TOKEN, env.JIRA_API_TOKEN, env.JIRA_EMAIL && env.JIRA_API_TOKEN ? Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64') : undefined]) {
    if (v && v.trim().length >= 3) out = out.split(v.trim()).join('[REDACTED]');
  }
  return out;
}
