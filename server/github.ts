import { db } from './store.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://ais-dev-fwrtdp4bsqhlus5qd4v3d3-856192480482.asia-southeast1.run.app';

export class GitHubService {
  /**
   * Generates the GitHub OAuth authorization URL
   */
  static getAuthUrl(redirectOrigin?: string): string {
    const origin = redirectOrigin || APP_URL;
    const redirectUri = `${origin}/auth/callback`;
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo,user:email',
      state: `state_${Date.now()}`
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for an access token
   */
  static async exchangeCodeForToken(code: string, redirectUri: string): Promise<{ token: string; username: string } | null> {
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri
        })
      });

      const data = await response.json();
      if (!data.access_token) {
        console.error('GitHub token exchange error:', data);
        return null;
      }

      // Fetch user profile to get username
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${data.access_token}`,
          'User-Agent': 'SquadForge-Swarm-Platform',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!userRes.ok) return null;
      const userData = await userRes.json();

      return {
        token: data.access_token,
        username: userData.login
      };
    } catch (err) {
      console.error('Failed to exchange code for GitHub token:', err);
      return null;
    }
  }

  /**
   * Validates a token and returns username
   */
  static async validateToken(token: string): Promise<string | null> {
    try {
      // If it's the demo mock token, accept it directly
      if (token.startsWith('ghp_demo')) {
        return 'squadforge-demo-dev';
      }

      const res = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'SquadForge-Swarm-Platform'
        }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.login;
    } catch (err) {
      return null;
    }
  }

  /**
   * Automatically creates a GitHub repository and commits all project files
   */
  static async autoPushProject(buildId: string, userId: string, repoNameSuggestion?: string): Promise<{ success: boolean; repoUrl?: string; error?: string }> {
    const token = db.getGithubToken(userId);
    if (!token) {
      return { success: false, error: 'No GitHub account connected. Please connect your GitHub account in Settings.' };
    }

    const files = db.getAllFiles(buildId);
    if (files.length === 0) {
      return { success: false, error: 'Cannot push empty project.' };
    }

    const build = db.getBuild(buildId);
    const repoName = (repoNameSuggestion || `squadforge-${(build?.idea || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${Date.now().toString().slice(-4)}`).replace(/^-+|-+$/g, '');

    // If demo token, simulate realistic successful push
    if (token.startsWith('ghp_demo')) {
      const demoUrl = `https://github.com/squadforge-dev/${repoName}`;
      if (build) {
        build.githubRepoUrl = demoUrl;
        db.saveBuild(build);
      }
      return { success: true, repoUrl: demoUrl };
    }

    try {
      // 1. Create Repository
      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SquadForge-Swarm-Platform'
        },
        body: JSON.stringify({
          name: repoName,
          description: `Built by SquadForge 10-AI Parallel Swarm: "${build?.idea || 'Autonomous Project'}"`,
          private: false,
          auto_init: true
        })
      });

      if (!createRes.ok) {
        const errData = await createRes.json();
        if (createRes.status === 401) {
          db.disconnectGithub(userId);
          return { success: false, error: 'GitHub token expired or revoked. Please reconnect GitHub in Settings.' };
        }
        return { success: false, error: errData.message || 'Failed to create GitHub repository' };
      }

      const repoData = await createRes.json();
      const owner = repoData.owner.login;
      const htmlUrl = repoData.html_url;

      // 2. Commit files one by one or create tree
      for (const file of files) {
        try {
          const contentBase64 = Buffer.from(file.content).toString('base64');
          await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'SquadForge-Swarm-Platform'
            },
            body: JSON.stringify({
              message: `Add ${file.path} (created by ${file.ownerModel})`,
              content: contentBase64
            })
          });
        } catch (fileErr) {
          console.warn(`Failed to push file ${file.path}:`, fileErr);
        }
      }

      if (build) {
        build.githubRepoUrl = htmlUrl;
        db.saveBuild(build);
      }

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'github_pushed',
        details: `Successfully auto-pushed project to GitHub: ${htmlUrl}`
      });

      return { success: true, repoUrl: htmlUrl };
    } catch (err: any) {
      console.error('GitHub auto-push exception:', err);
      return { success: false, error: err.message || 'Network error pushing to GitHub' };
    }
  }
}
