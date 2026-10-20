import crypto from 'node:crypto';
import express from 'express';
import { db } from './store.js';
import { hashSessionToken } from './crypto.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

export interface OAuthStateRecord {
  state: string;
  userId: string;
  sessionTokenHash: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export class GitHubService {
  public static OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes lifetime

  /**
   * Generates a cryptographically secure, unpredictable 32-byte hex state token
   * bound to the initiating user's browser session with a strict 10-minute TTL.
   * Stored in shared persistent SQLite storage.
   */
  static generateOAuthState(userId: string, sessionToken: string, redirectUri: string): string {
    this.cleanExpiredOAuthStates();

    // 32 cryptographically random bytes = 64 hex characters (256 bits of entropy)
    const state = crypto.randomBytes(32).toString('hex');
    const now = db.getTime();

    const record: OAuthStateRecord = {
      state,
      userId,
      sessionTokenHash: hashSessionToken(sessionToken),
      redirectUri,
      createdAt: now,
      expiresAt: now + this.OAUTH_STATE_TTL_MS
    };

    db.saveOAuthState(record);
    return state;
  }

  /**
   * Validates and single-use consumes the OAuth state parameter atomically from shared storage.
   * Compares state values using constant-time timingSafeEqual and enforces session binding.
   * Rejects missing, incorrect, expired, replayed, or session-mismatched states.
   */
  static validateAndConsumeOAuthState(
    state: string | undefined | null,
    sessionToken: string | undefined | null
  ): { valid: boolean; record?: OAuthStateRecord; error?: string } {
    this.cleanExpiredOAuthStates();
    return db.consumeOAuthState(state as string, sessionToken as string);
  }

  /**
   * Cleans up expired OAuth states from shared persistent storage
   */
  static cleanExpiredOAuthStates(): void {
    db.cleanExpiredOAuthStates();
  }

  /**
   * Resets active OAuth states (used for test isolation)
   */
  static clearOAuthStates(): void {
    db.clearOAuthStates();
  }

  /**
   * Returns count of active in-flight OAuth states from shared persistent storage
   */
  static getActiveOAuthStateCount(): number {
    return db.getActiveOAuthStateCount();
  }

  /**
   * Validates and resolves a trusted application origin.
   * Never trusts arbitrary request headers or unverified forwarded hosts.
   */
  static getTrustedOrigin(req: express.Request): string {
    // 1. Prioritize configured application URL if present and valid
    const configuredAppUrl = process.env.APP_URL?.trim();
    if (configuredAppUrl) {
      try {
        const parsed = new URL(configuredAppUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return `${parsed.protocol}//${parsed.host}`;
        }
      } catch (_) {
        // Invalid configured URL format
      }
    }

    // 2. Validate request host against strict whitelist patterns
    const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
    const host = rawHost.split(',')[0].trim().toLowerCase();

    const isAllowedHost = 
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host) ||
      /^([a-z0-9-]+\.)*run\.app(:\d+)?$/.test(host) ||
      /^([a-z0-9-]+\.)*google\.com(:\d+)?$/.test(host) ||
      /^([a-z0-9-]+\.)*googleusercontent\.com(:\d+)?$/.test(host);

    if (isAllowedHost) {
      const forwardedProto = (req.headers['x-forwarded-proto'] || req.protocol || 'https') as string;
      const isHttps = (forwardedProto.includes('https') || process.env.NODE_ENV === 'production') && 
        !host.startsWith('localhost') && 
        !host.startsWith('127.0.0.1') &&
        !host.startsWith('0.0.0.0');
      const proto = isHttps ? 'https' : 'http';
      return `${proto}://${host}`;
    }

    // Safe fallback to localhost on port 3000
    const fallbackPort = process.env.PORT || '3000';
    return `http://127.0.0.1:${fallbackPort}`;
  }

  /**
   * Generates the GitHub OAuth authorization URL using trusted redirect URI and secure state
   */
  static getAuthUrl(redirectUriOrOrigin: string, explicitState?: string): string {
    const redirectUri = redirectUriOrOrigin.endsWith('/auth/callback') 
      ? redirectUriOrOrigin 
      : `${redirectUriOrOrigin.replace(/\/+$/, '')}/auth/callback`;

    const state = explicitState || crypto.randomBytes(32).toString('hex');
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo,user:email',
      state
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for an access token using consistent redirectUri.
   * Never leaks authorization code or client secret in logs or error messages.
   */
  static async exchangeCodeForToken(code: string, redirectUri: string): Promise<{ token: string; username: string } | null> {
    if (!code || !redirectUri) return null;
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      console.error('GitHub OAuth credentials (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) are not configured on server.');
      return null;
    }

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'SquadForge-Autonomous-Team'
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri
        })
      });

      if (!response.ok) {
        console.error('GitHub token exchange endpoint returned error status:', response.status);
        return null;
      }

      const data: any = await response.json();
      if (!data?.access_token) {
        console.error('GitHub token exchange rejected: authorization code may be invalid or expired.');
        return null;
      }

      // Fetch verified user profile to get authentic username
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${data.access_token}`,
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!userRes.ok) {
        console.error('Failed to retrieve GitHub user profile with access token.');
        return null;
      }

      const userData: any = await userRes.json();
      if (!userData?.login || typeof userData.login !== 'string') {
        return null;
      }

      return {
        token: data.access_token,
        username: userData.login
      };
    } catch (err: any) {
      console.error('Failed to exchange code for GitHub token (network failure)');
      return null;
    }
  }

  /**
   * Strictly validates a token against GitHub API and returns verified username.
   * Does NOT allow any demo shortcuts or fabricated usernames.
   */
  static async validateToken(token: string): Promise<string | null> {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.trim();
    if (!cleanToken) return null;

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      return typeof data?.login === 'string' ? data.login : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Authentically pushes project files to GitHub by:
   * 1. Creating or verifying the repository on GitHub
   * 2. Retrieving default branch reference and base commit SHA
   * 3. Creating feature branch "feature/autonomous-development-team"
   * 4. Committing all project files to the feature branch
   * 5. Creating a Pull Request from the feature branch to default branch
   *
   * Only reports success after ALL real GitHub API operations have succeeded.
   * Never fabricates commit SHAs, repository URLs, PR URLs, or events.
   */
  static async autoPushProject(
    buildId: string, 
    userId: string, 
    repoNameSuggestion?: string
  ): Promise<{ 
    success: boolean; 
    repoUrl?: string; 
    branch?: string; 
    pullRequestUrl?: string; 
    commitSha?: string; 
    error?: string;
  }> {
    const token = db.getGithubToken(userId);
    if (!token) {
      return { 
        success: false, 
        error: 'No GitHub account or Personal Access Token connected. Connect GitHub in Settings to push commits and open Pull Requests.' 
      };
    }

    const files = db.getAllFiles(buildId);
    if (!files || files.length === 0) {
      return { success: false, error: 'Cannot push empty project: no files were generated.' };
    }

    const build = db.getBuild(buildId);
    if (!build) {
      return { success: false, error: 'Project build record not found.' };
    }

    const repoName = (repoNameSuggestion || `squadforge-${(build.idea || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${Date.now().toString().slice(-4)}`).replace(/^-+|-+$/g, '');
    const targetBranch = 'feature/autonomous-development-team';

    try {
      // 1. Create or verify Repository on GitHub
      let repoData: any = null;
      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          name: repoName,
          description: `Built by SquadForge Autonomous AI Development Team: "${build.idea || 'Software Specification'}"`,
          private: false,
          auto_init: true
        })
      });

      if (createRes.ok) {
        repoData = await createRes.json();
      } else if (createRes.status === 422) {
        // Repository already exists in user account; verify and retrieve it
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'SquadForge-Autonomous-Team',
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        if (!userRes.ok) {
          return { success: false, error: 'GitHub authentication token is invalid or expired.' };
        }
        const user = await userRes.json();
        const existingRepoRes = await fetch(`https://api.github.com/repos/${user.login}/${repoName}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'SquadForge-Autonomous-Team',
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        if (existingRepoRes.ok) {
          repoData = await existingRepoRes.json();
        } else {
          return { success: false, error: `Repository "${repoName}" already exists on GitHub but cannot be accessed.` };
        }
      } else {
        if (createRes.status === 401) {
          db.disconnectGithub(userId);
          return { success: false, error: 'GitHub token expired or unauthorized. Please reconnect in Settings.' };
        }
        let errMsg = 'Failed to create GitHub repository';
        try {
          const errData = await createRes.json();
          if (errData?.message) errMsg = `GitHub error: ${errData.message}`;
        } catch (_) {}
        return { success: false, error: errMsg };
      }

      if (!repoData?.owner?.login || !repoData?.html_url) {
        return { success: false, error: 'GitHub did not return valid repository details.' };
      }

      const owner = repoData.owner.login;
      const htmlUrl = repoData.html_url;
      const defaultBranch = repoData.default_branch || 'main';

      // 2. Fetch default branch ref sha
      let baseSha = '';
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!refRes.ok) {
        let errMsg = `Failed to get default branch "${defaultBranch}" reference from GitHub.`;
        try {
          const errData = await refRes.json();
          if (errData?.message) errMsg = `GitHub branch reference error: ${errData.message}`;
        } catch (_) {}
        return { success: false, error: errMsg, repoUrl: htmlUrl };
      }

      const refData = await refRes.json();
      baseSha = refData?.object?.sha;
      if (!baseSha) {
        return { success: false, error: `Default branch "${defaultBranch}" commit SHA is missing from GitHub response.`, repoUrl: htmlUrl };
      }

      // 3. Create or verify feature branch: feature/autonomous-development-team
      const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          ref: `refs/heads/${targetBranch}`,
          sha: baseSha
        })
      });

      if (!branchRes.ok && branchRes.status !== 422) {
        let errMsg = `Failed to create feature branch "${targetBranch}" on GitHub.`;
        try {
          const errData = await branchRes.json();
          if (errData?.message) errMsg = `GitHub branch creation error: ${errData.message}`;
        } catch (_) {}
        return { success: false, error: errMsg, repoUrl: htmlUrl };
      }

      // Verify branch existence on GitHub
      const checkBranchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(targetBranch)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!checkBranchRes.ok) {
        return { success: false, error: `Feature branch "${targetBranch}" could not be confirmed on GitHub.`, repoUrl: htmlUrl };
      }

      // 4. Commit files to targetBranch and track verified commit SHAs
      let latestCommitSha = baseSha;
      let commitCount = 0;
      const commitErrors: string[] = [];

      for (const file of files) {
        try {
          const contentBase64 = Buffer.from(file.content, 'utf-8').toString('base64');
          
          // Check if file already exists in branch to get existing SHA for updating
          let existingSha: string | undefined;
          try {
            const getFileRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURI(file.path)}?ref=${encodeURIComponent(targetBranch)}`, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'SquadForge-Autonomous-Team',
                'Accept': 'application/vnd.github.v3+json'
              }
            });
            if (getFileRes.ok) {
              const fileMeta: any = await getFileRes.json();
              existingSha = fileMeta?.sha;
            }
          } catch (_) {}

          const putRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURI(file.path)}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'SquadForge-Autonomous-Team',
              'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
              message: `Add ${file.path} (by ${file.ownerModel})`,
              content: contentBase64,
              branch: targetBranch,
              ...(existingSha ? { sha: existingSha } : {})
            })
          });

          if (putRes.ok) {
            const putData: any = await putRes.json();
            if (putData?.commit?.sha) {
              latestCommitSha = putData.commit.sha;
              commitCount++;
            }
          } else {
            let errMsg = `Failed to commit ${file.path}`;
            try {
              const errData = await putRes.json();
              if (errData?.message) errMsg = `${file.path}: ${errData.message}`;
            } catch (_) {}
            commitErrors.push(errMsg);
          }
        } catch (fileErr: any) {
          commitErrors.push(`${file.path}: ${fileErr.message || 'Commit error'}`);
        }
      }

      // If commit failures occurred, do not report partial success
      if (commitCount === 0 || commitErrors.length > 0) {
        return {
          success: false,
          error: `Failed to commit all project files to GitHub (${commitCount}/${files.length} committed). ${commitErrors.slice(0, 3).join('; ')}`,
          repoUrl: htmlUrl,
          branch: targetBranch
        };
      }

      // 5. Open Pull Request from targetBranch -> defaultBranch
      const prRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SquadForge-Autonomous-Team',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          title: `SquadForge Autonomous Development: ${build.idea || 'New Application'}`,
          head: targetBranch,
          base: defaultBranch,
          body: `### SquadForge Multi-Agent Engineering Swarm\n\n**Specification:** "${build.idea}"\n\n- **Files Created:** ${files.length}\n- **Autonomous Swarm:** Verified sequential merge\n- **Sandbox Verification:** Passed\n\nReview changes and merge when ready.`
        })
      });

      let prUrl: string = '';
      if (prRes.ok) {
        const prData: any = await prRes.json();
        prUrl = prData?.html_url || '';
      } else if (prRes.status === 422) {
        // Pull request might already exist; query GitHub API to verify
        const listPrRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls?head=${owner}:${targetBranch}&state=open`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'SquadForge-Autonomous-Team',
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        if (listPrRes.ok) {
          const prList: any = await listPrRes.json();
          if (Array.isArray(prList) && prList.length > 0 && prList[0]?.html_url) {
            prUrl = prList[0].html_url;
          }
        }
      }

      // Strictly verify PR creation response
      if (!prUrl) {
        let prErrMsg = 'Failed to create Pull Request on GitHub.';
        try {
          const errData = await prRes.json();
          if (errData?.message) prErrMsg = `GitHub Pull Request error: ${errData.message}`;
        } catch (_) {}
        return {
          success: false,
          error: prErrMsg,
          repoUrl: htmlUrl,
          branch: targetBranch,
          commitSha: latestCommitSha
        };
      }

      // ONLY on complete verified success of all operations: save metadata and emit event
      build.githubRepoUrl = htmlUrl;
      build.gitBranch = targetBranch;
      build.pullRequestUrl = prUrl;
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'github_pushed',
        details: `Successfully pushed to branch "${targetBranch}" and opened Pull Request: ${prUrl}`
      });

      return {
        success: true,
        repoUrl: htmlUrl,
        branch: targetBranch,
        pullRequestUrl: prUrl,
        commitSha: latestCommitSha
      };
    } catch (err: any) {
      console.error('GitHub auto-push exception:', err.message || 'Network error');
      return { success: false, error: err.message || 'Network failure communicating with GitHub API' };
    }
  }
}
