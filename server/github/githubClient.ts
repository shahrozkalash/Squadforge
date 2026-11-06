/**
 * SquadForge GitHub API Client
 * Authentic implementation for GitHub REST and Git Data APIs.
 * Tokens are strictly server-side and never exposed to the client.
 */

export interface GitHubApiOptions {
  token: string;
  baseUrl?: string;
  customFetch?: typeof fetch;
}

export interface GitHubApiErrorDetails {
  status: number;
  message: string;
  documentation_url?: string;
  errors?: any[];
}

export class GitHubApiError extends Error {
  public status: number;
  public details?: GitHubApiErrorDetails;

  constructor(status: number, message: string, details?: GitHubApiErrorDetails) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.details = details;
  }
}

export class GitHubClient {
  private token: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(options: GitHubApiOptions) {
    if (!options.token || typeof options.token !== 'string' || !options.token.trim()) {
      throw new Error('GitHub access token is required to initialize GitHubClient');
    }
    this.token = options.token.trim();
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.fetchFn = options.customFetch || fetch;
  }

  private async request<T = any>(
    endpoint: string, 
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', 
    body?: any
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': 'SquadForge-Autonomous-Team',
      'Accept': 'application/vnd.github.v3+json'
    };

    if (body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      let errDetails: GitHubApiErrorDetails = {
        status: response.status,
        message: `GitHub API request failed with status ${response.status}`
      };
      try {
        const json = await response.json();
        if (json && typeof json === 'object') {
          errDetails = {
            status: response.status,
            message: json.message || errDetails.message,
            documentation_url: json.documentation_url,
            errors: json.errors
          };
        }
      } catch {
        try {
          const text = await response.text();
          if (text) errDetails.message = text;
        } catch {}
      }

      throw new GitHubApiError(response.status, errDetails.message, errDetails);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  // --- User Profile & Authentication ---

  async getUser(): Promise<any> {
    return this.request('/user');
  }

  // --- Repositories ---

  async listUserRepos(options: { sort?: string; direction?: string; per_page?: number } = {}): Promise<any[]> {
    const params = new URLSearchParams({
      sort: options.sort || 'updated',
      direction: options.direction || 'desc',
      per_page: String(options.per_page || 100),
      affiliation: 'owner,collaborator,organization_member'
    });
    return this.request(`/user/repos?${params.toString()}`);
  }

  async getRepo(owner: string, repo: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  // --- Branches ---

  async listBranches(owner: string, repo: string): Promise<any[]> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`);
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`);
  }

  // --- Git References (Git Data API) ---

  async getRef(owner: string, repo: string, ref: string): Promise<any> {
    let clean = ref.replace(/^refs\//, '');
    if (!clean.startsWith('heads/') && !clean.startsWith('tags/')) {
      clean = `heads/${clean}`;
    }
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${clean}`);
  }

  async createRef(owner: string, repo: string, ref: string, sha: string): Promise<any> {
    let fullRef = ref;
    if (!fullRef.startsWith('refs/')) {
      if (fullRef.startsWith('heads/') || fullRef.startsWith('tags/')) {
        fullRef = `refs/${fullRef}`;
      } else {
        fullRef = `refs/heads/${fullRef}`;
      }
    }
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, 'POST', {
      ref: fullRef,
      sha
    });
  }

  async updateRef(owner: string, repo: string, ref: string, sha: string, force = false): Promise<any> {
    let clean = ref.replace(/^refs\//, '');
    if (!clean.startsWith('heads/') && !clean.startsWith('tags/')) {
      clean = `heads/${clean}`;
    }
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${clean}`, 'PATCH', {
      sha,
      force
    });
  }

  // --- Git Trees & Blobs ---

  async getTree(owner: string, repo: string, treeSha: string, recursive = true): Promise<any> {
    const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}${recursive ? '?recursive=1' : ''}`;
    return this.request(url);
  }

  async getBlob(owner: string, repo: string, blobSha: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`);
  }

  async createBlob(owner: string, repo: string, content: string, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<{ sha: string; url: string }> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, 'POST', {
      content,
      encoding
    });
  }

  async createTree(
    owner: string, 
    repo: string, 
    baseTreeSha: string | null, 
    tree: Array<{ path: string; mode: string; type: string; sha?: string | null }>
  ): Promise<any> {
    const payload: any = { tree };
    if (baseTreeSha) {
      payload.base_tree = baseTreeSha;
    }
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, 'POST', payload);
  }

  // --- Git Commits ---

  async createCommit(
    owner: string, 
    repo: string, 
    message: string, 
    treeSha: string, 
    parentShas: string[],
    author?: { name: string; email: string; date?: string }
  ): Promise<any> {
    const payload: any = {
      message,
      tree: treeSha,
      parents: parentShas
    };
    if (author) {
      payload.author = {
        name: author.name,
        email: author.email,
        date: author.date || new Date().toISOString()
      };
      payload.committer = { ...payload.author };
    }
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, 'POST', payload);
  }

  async listCommits(owner: string, repo: string, options: { sha?: string; path?: string; per_page?: number } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.sha) params.set('sha', options.sha);
    if (options.path) params.set('path', options.path);
    params.set('per_page', String(options.per_page || 30));
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params.toString()}`);
  }

  async getCommit(owner: string, repo: string, commitSha: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}`);
  }

  async compareCommits(owner: string, repo: string, baseSha: string, headSha: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`);
  }

  // --- Pull Requests ---

  async listPullRequests(owner: string, repo: string, options: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    params.set('state', options.state || 'open');
    if (options.head) params.set('head', options.head);
    if (options.base) params.set('base', options.base);
    params.set('per_page', '50');
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`);
  }

  async createPullRequest(owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, 'POST', {
      title,
      body,
      head,
      base
    });
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<any> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`);
  }

  async mergePullRequest(
    owner: string, 
    repo: string, 
    pullNumber: number, 
    options: { commitMessage?: string; mergeMethod?: 'merge' | 'squash' | 'rebase' } = {}
  ): Promise<any> {
    const payload: any = {};
    if (options.commitMessage) payload.commit_message = options.commitMessage;
    if (options.mergeMethod) payload.merge_method = options.mergeMethod;
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/merge`, 'PUT', payload);
  }
}
