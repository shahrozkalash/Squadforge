import React, { useState, useEffect, useRef } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { useAuth } from '../context/AuthContext.js';
import {
  DeploymentRecord,
  DeploymentProviderType,
  DeploymentEnvironment,
  SafeDeploymentSecret,
  PreDeploymentValidationResult,
  CustomDomainResult
} from '../types/index.js';
import {
  Rocket,
  Globe,
  Shield,
  Lock,
  Terminal,
  Download,
  RotateCcw,
  CheckCircle,
  AlertTriangle,
  XCircle,
  ExternalLink,
  RefreshCw,
  Plus,
  Trash2,
  Copy,
  Check,
  Server,
  Cloud,
  Box,
  Webhook,
  Activity,
  Layers,
  ChevronRight,
  Filter
} from 'lucide-react';

export const DeploymentView: React.FC = () => {
  const { activeBuild } = useSwarm();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<'overview' | 'validation' | 'logs' | 'secrets' | 'domains' | 'history'>('overview');
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [selectedDeployment, setSelectedDeployment] = useState<DeploymentRecord | null>(null);
  const [validationResult, setValidationResult] = useState<PreDeploymentValidationResult | null>(null);
  const [secrets, setSecrets] = useState<SafeDeploymentSecret[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Deploy configuration form state
  const [selectedProvider, setSelectedProvider] = useState<DeploymentProviderType>('static_host');
  const [selectedEnvironment, setSelectedEnvironment] = useState<DeploymentEnvironment>('production');
  const [skipApproval, setSkipApproval] = useState(false);

  // Secret form state
  const [newSecretKey, setNewSecretKey] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [newSecretEnv, setNewSecretEnv] = useState('all');

  // Domain configuration state
  const [customDomainInput, setCustomDomainInput] = useState('');
  const [domainConfigResult, setDomainConfigResult] = useState<CustomDomainResult | null>(null);
  const [domainVerifying, setDomainVerifying] = useState(false);

  // Logs filtering
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'success'>('all');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const buildId = activeBuild?.id;

  // Fetch deployments and secrets on build change
  useEffect(() => {
    if (!buildId) return;
    fetchDeployments();
    fetchValidation();
    fetchSecrets();
  }, [buildId]);

  // Auto-select latest deployment
  useEffect(() => {
    if (deployments.length > 0 && !selectedDeployment) {
      setSelectedDeployment(deployments[0]);
    } else if (deployments.length > 0 && selectedDeployment) {
      const updated = deployments.find(d => d.id === selectedDeployment.id);
      if (updated) setSelectedDeployment(updated);
    }
  }, [deployments]);

  // Polling for active deployment status updates
  useEffect(() => {
    if (!selectedDeployment) return;
    const isTransitional = ['validating', 'building', 'deploying'].includes(selectedDeployment.status);
    if (!isTransitional) return;

    const interval = setInterval(() => {
      fetchDeploymentDetails(selectedDeployment.id);
    }, 2000);

    return () => clearInterval(interval);
  }, [selectedDeployment?.id, selectedDeployment?.status]);

  const fetchDeployments = async () => {
    if (!buildId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/builds/${buildId}/deployments`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDeployments(data.deployments || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchDeploymentDetails = async (id: string) => {
    try {
      const res = await fetch(`/api/deployments/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.deployment) {
        setSelectedDeployment(data.deployment);
        setDeployments(prev => prev.map(d => d.id === id ? data.deployment : d));
      }
    } catch {
      // ignore poll error
    }
  };

  const fetchValidation = async () => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/pre-deploy-validation`);
      if (res.ok) {
        const data = await res.json();
        setValidationResult(data);
      }
    } catch (err) {
      console.error('Validation check failed:', err);
    }
  };

  const fetchSecrets = async () => {
    if (!buildId) return;
    try {
      const res = await fetch(`/api/builds/${buildId}/deployment-secrets`);
      if (res.ok) {
        const data = await res.json();
        setSecrets(data.secrets || []);
      }
    } catch (err) {
      console.error('Fetch secrets error:', err);
    }
  };

  const handleTriggerDeploy = async () => {
    if (!buildId) return;
    try {
      setActionLoading(true);
      setError(null);
      setSuccessMsg(null);

      const res = await fetch(`/api/builds/${buildId}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          environment: selectedEnvironment,
          skipApprovalGate: skipApproval
        })
      });

      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || 'Failed to trigger deployment');
      }

      if (res.status === 202) {
        setSuccessMsg('Deployment initiated and held in Human Approval Gate.');
      } else {
        setSuccessMsg('Deployment initiated successfully! Building distribution bundle...');
      }

      await fetchDeployments();
      if (data.deployment) {
        setSelectedDeployment(data.deployment);
      }
      setActiveTab('overview');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async (deploymentId: string) => {
    try {
      setActionLoading(true);
      setError(null);
      const res = await fetch(`/api/deployments/${deploymentId}/approve`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to approve deployment');
      setSuccessMsg('Deployment approved! Build and release pipeline in progress.');
      await fetchDeploymentDetails(deploymentId);
      await fetchDeployments();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async (deploymentId: string) => {
    try {
      setActionLoading(true);
      setError(null);
      const res = await fetch(`/api/deployments/${deploymentId}/cancel`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel deployment');
      setSuccessMsg('Deployment cancelled.');
      await fetchDeploymentDetails(deploymentId);
      await fetchDeployments();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRollback = async (targetId: string) => {
    if (!selectedDeployment) return;
    try {
      setActionLoading(true);
      setError(null);
      const res = await fetch(`/api/deployments/${selectedDeployment.id}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDeploymentId: targetId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to execute rollback');
      setSuccessMsg('Rollback initiated successfully to target release.');
      await fetchDeployments();
      if (data.deployment) setSelectedDeployment(data.deployment);
      setActiveTab('overview');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!buildId || !newSecretKey.trim()) return;

    try {
      setActionLoading(true);
      setError(null);
      const res = await fetch(`/api/builds/${buildId}/deployment-secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: newSecretKey.trim(),
          value: newSecretValue,
          environment: newSecretEnv
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save secret');

      setNewSecretKey('');
      setNewSecretValue('');
      setSuccessMsg(`Secret ${data.secret.key} encrypted and stored.`);
      await fetchSecrets();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteSecret = async (secretId: string) => {
    if (!buildId) return;
    try {
      setActionLoading(true);
      const res = await fetch(`/api/builds/${buildId}/deployment-secrets/${secretId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(await res.text());
      setSuccessMsg('Secret deleted.');
      await fetchSecrets();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfigureDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDeployment || !customDomainInput.trim()) return;

    try {
      setDomainVerifying(true);
      setError(null);
      const res = await fetch(`/api/deployments/${selectedDeployment.id}/custom-domain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: customDomainInput.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to configure custom domain');
      setDomainConfigResult(data);
      setSuccessMsg(`Custom domain configured. Please add the DNS records below to verify.`);
      await fetchDeploymentDetails(selectedDeployment.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDomainVerifying(false);
    }
  };

  const handleVerifyDomain = async () => {
    if (!selectedDeployment) return;
    try {
      setDomainVerifying(true);
      setError(null);
      const res = await fetch(`/api/deployments/${selectedDeployment.id}/custom-domain/verify`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      if (data.verified) {
        setSuccessMsg(data.message || 'Domain verified and active!');
      } else {
        setError(data.message || 'Domain DNS verification pending. Please allow DNS propagation.');
      }
      await fetchDeploymentDetails(selectedDeployment.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDomainVerifying(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle className="w-3.5 h-3.5" />
            Active & Live
          </span>
        );
      case 'pending_approval':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <Lock className="w-3.5 h-3.5 animate-pulse" />
            Pending Human Approval
          </span>
        );
      case 'validating':
      case 'building':
      case 'deploying':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/30">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            {status === 'validating' ? 'Validating...' : status === 'building' ? 'Building Bundle...' : 'Deploying...'}
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <XCircle className="w-3.5 h-3.5" />
            Failed
          </span>
        );
      case 'rolled_back':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/30">
            <RotateCcw className="w-3.5 h-3.5" />
            Rolled Back
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-neutral-800 text-neutral-400 border border-neutral-700">
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-neutral-800 text-neutral-400">
            {status}
          </span>
        );
    }
  };

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case 'static_host':
        return <Server className="w-4 h-4 text-amber-400" />;
      case 'cloudflare_pages':
        return <Cloud className="w-4 h-4 text-amber-500" />;
      case 'vercel':
        return <Rocket className="w-4 h-4 text-white" />;
      case 'netlify':
        return <Globe className="w-4 h-4 text-teal-400" />;
      case 'docker_container':
        return <Box className="w-4 h-4 text-blue-400" />;
      case 'custom_webhook':
        return <Webhook className="w-4 h-4 text-purple-400" />;
      default:
        return <Server className="w-4 h-4 text-neutral-400" />;
    }
  };

  const filteredLogs = selectedDeployment?.buildLogs.filter(log => {
    if (logFilter === 'all') return true;
    return log.level === logFilter;
  }) || [];

  if (!buildId) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center">
        <Rocket className="w-12 h-12 text-neutral-600 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">No Active Project Selected</h2>
        <p className="text-sm text-neutral-400">
          Create or select an active project in the Idea Forge tab to configure and deploy software.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <Rocket className="w-6 h-6 text-amber-400" />
            <h1 className="text-xl font-bold tracking-tight text-white">
              Deployment & Distribution Engine
            </h1>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">
              Phase 15
            </span>
          </div>
          <p className="text-sm text-neutral-400 mt-1">
            Production builds, modular provider deployment, secure secrets, custom domains, and instant rollbacks.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => { fetchDeployments(); fetchValidation(); }}
            className="px-3 py-1.5 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg hover:bg-neutral-800 transition-colors flex items-center gap-1.5"
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            onClick={handleTriggerDeploy}
            disabled={actionLoading}
            className="px-4 py-2 text-sm font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg shadow-sm transition-colors flex items-center gap-2"
          >
            <Rocket className="w-4 h-4" />
            <span>Deploy Application</span>
          </button>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-neutral-400 hover:text-white">✕</button>
        </div>
      )}

      {successMsg && (
        <div className="p-4 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-sm flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">{successMsg}</div>
          <button onClick={() => setSuccessMsg(null)} className="text-neutral-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Human Approval Gate Alert (if current deployment is pending) */}
      {selectedDeployment && selectedDeployment.status === 'pending_approval' && (
        <div className="p-5 rounded-2xl bg-amber-950/30 border border-amber-600/50 text-neutral-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-amber-300 flex items-center gap-2">
                Production Deployment Approval Gate
                <span className="text-xs font-mono font-normal px-2 py-0.5 rounded bg-amber-500/20 text-amber-200">
                  High Risk Action
                </span>
              </h3>
              <p className="text-sm text-neutral-300 mt-1 max-w-2xl">
                This production deployment targeting <span className="font-semibold text-white">{selectedDeployment.provider}</span> will compile and activate real production release artifacts. Invariant rules require explicit human approval before release.
              </p>
              {selectedDeployment.approvalId && (
                <p className="text-xs font-mono text-neutral-400 mt-1">
                  Approval Request: {selectedDeployment.approvalId}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => handleCancel(selectedDeployment.id)}
              disabled={actionLoading}
              className="px-3.5 py-2 text-sm font-medium text-neutral-300 bg-neutral-900 border border-neutral-700 rounded-lg hover:bg-neutral-800 transition-colors"
            >
              Reject & Cancel
            </button>
            <button
              onClick={() => handleApprove(selectedDeployment.id)}
              disabled={actionLoading}
              className="px-4 py-2 text-sm font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              <span>Approve & Release</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Navigation Subtabs */}
      <div className="flex border-b border-neutral-800 text-sm font-medium text-neutral-400 gap-1 overflow-x-auto">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'overview'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Rocket className="w-4 h-4" />
          <span>Overview & Launch</span>
        </button>

        <button
          onClick={() => setActiveTab('validation')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'validation'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Shield className="w-4 h-4" />
          <span>Pre-Deploy Validation</span>
          {validationResult && (
            <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-bold ${
              validationResult.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
            }`}>
              {validationResult.readinessScore}/100
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'logs'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Terminal className="w-4 h-4" />
          <span>Build & Deploy Logs</span>
          {selectedDeployment && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
              {selectedDeployment.buildLogs.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('secrets')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'secrets'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Lock className="w-4 h-4" />
          <span>Environment & Secrets</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
            {secrets.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('domains')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'domains'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Globe className="w-4 h-4" />
          <span>Custom Domains</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === 'history'
              ? 'text-amber-400 border-amber-400 font-semibold'
              : 'border-transparent hover:text-white'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Deployment History</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
            {deployments.length}
          </span>
        </button>
      </div>

      {/* TAB 1: OVERVIEW & LAUNCH */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Active Deployment Card */}
          <div className="lg:col-span-2 space-y-6">
            <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center">
                    {selectedDeployment ? getProviderIcon(selectedDeployment.provider) : <Rocket className="w-5 h-5 text-amber-400" />}
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">
                      {selectedDeployment ? `${selectedDeployment.provider.replace('_', ' ').toUpperCase()} Deployment` : 'No Deployments Yet'}
                    </h2>
                    <p className="text-xs text-neutral-400 font-mono">
                      {selectedDeployment ? `Release ID: ${selectedDeployment.id}` : 'Deploy your project to make it live'}
                    </p>
                  </div>
                </div>

                {selectedDeployment && getStatusBadge(selectedDeployment.status)}
              </div>

              {selectedDeployment && (
                <div className="space-y-4 pt-2 border-t border-neutral-800/80">
                  {/* Target Live URL */}
                  <div>
                    <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
                      Live Production URL
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-neutral-950 border border-neutral-800 text-sm font-mono text-neutral-200 overflow-x-auto">
                        <span className="truncate">{selectedDeployment.targetUrl || 'Awaiting activation...'}</span>
                        {selectedDeployment.targetUrl && (
                          <span className="text-xs text-emerald-400 flex items-center gap-1 shrink-0 ml-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            Confirmed Live
                          </span>
                        )}
                      </div>

                      {selectedDeployment.targetUrl && (
                        <>
                          <button
                            onClick={() => copyToClipboard(window.location.origin + selectedDeployment.targetUrl)}
                            className="p-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors"
                            title="Copy URL"
                          >
                            {copiedUrl ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                          </button>
                          <a
                            href={selectedDeployment.targetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3.5 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-neutral-950 font-medium text-xs flex items-center gap-1.5 transition-colors"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Metadata Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                    <div className="p-3 rounded-lg bg-neutral-950/60 border border-neutral-800/60">
                      <span className="text-[11px] text-neutral-500 uppercase block font-medium">Environment</span>
                      <span className="text-sm font-bold text-white uppercase">{selectedDeployment.environment}</span>
                    </div>

                    <div className="p-3 rounded-lg bg-neutral-950/60 border border-neutral-800/60">
                      <span className="text-[11px] text-neutral-500 uppercase block font-medium">Commit SHA</span>
                      <span className="text-xs font-mono text-amber-300 truncate block">
                        {selectedDeployment.commitSha ? selectedDeployment.commitSha.slice(0, 8) : 'latest'}
                      </span>
                    </div>

                    <div className="p-3 rounded-lg bg-neutral-950/60 border border-neutral-800/60">
                      <span className="text-[11px] text-neutral-500 uppercase block font-medium">Artifact Size</span>
                      <span className="text-sm font-mono text-neutral-200">
                        {selectedDeployment.buildArtifactSize ? `${(selectedDeployment.buildArtifactSize / 1024).toFixed(1)} KB` : 'N/A'}
                      </span>
                    </div>

                    <div className="p-3 rounded-lg bg-neutral-950/60 border border-neutral-800/60">
                      <span className="text-[11px] text-neutral-500 uppercase block font-medium">Deployed At</span>
                      <span className="text-xs text-neutral-300">
                        {selectedDeployment.deployedAt ? new Date(selectedDeployment.deployedAt).toLocaleTimeString() : 'Pending'}
                      </span>
                    </div>
                  </div>

                  {/* Download Artifact Button */}
                  {selectedDeployment.buildArtifactPath && (
                    <div className="pt-2 flex items-center justify-between p-3 rounded-xl bg-neutral-950 border border-neutral-800">
                      <div className="flex items-center gap-2.5">
                        <Download className="w-4 h-4 text-amber-400" />
                        <div>
                          <p className="text-xs font-semibold text-white">Production Build Bundle (.zip)</p>
                          <p className="text-[11px] text-neutral-500 font-mono">
                            SHA-256: {selectedDeployment.buildArtifactHash ? selectedDeployment.buildArtifactHash.slice(0, 16) + '...' : 'Verified'}
                          </p>
                        </div>
                      </div>

                      <a
                        href={`/api/deployments/${selectedDeployment.id}/artifact`}
                        download
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download ZIP
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Quick Log Preview */}
            {selectedDeployment && selectedDeployment.buildLogs.length > 0 && (
              <div className="p-5 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-amber-400" />
                    <h3 className="text-sm font-bold text-white">Recent Deployment Logs</h3>
                  </div>
                  <button
                    onClick={() => setActiveTab('logs')}
                    className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
                  >
                    View All Logs
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="p-3.5 rounded-xl bg-neutral-950 border border-neutral-800 font-mono text-xs text-neutral-300 space-y-1.5 max-h-48 overflow-y-auto">
                  {selectedDeployment.buildLogs.slice(-6).map((l, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <span className="text-neutral-500 text-[10px] shrink-0">
                        {new Date(l.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={`px-1 py-0.2 rounded text-[9px] uppercase font-bold shrink-0 ${
                        l.level === 'error' ? 'bg-rose-500/20 text-rose-400' :
                        l.level === 'warn' ? 'bg-amber-500/20 text-amber-400' :
                        l.level === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                        'bg-neutral-800 text-neutral-400'
                      }`}>
                        {l.level}
                      </span>
                      <span className="break-all">{l.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Launch Configuration Card */}
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Rocket className="w-4 h-4 text-amber-400" />
                Deploy Configuration
              </h3>

              {/* Provider Selection */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block">
                  Hosting Provider
                </label>
                <div className="space-y-2">
                  {[
                    { id: 'static_host', name: 'SquadForge Static Host', desc: 'Instant self-hosted static web app with zero credentials', icon: <Server className="w-4 h-4 text-amber-400" /> },
                    { id: 'cloudflare_pages', name: 'Cloudflare Pages', desc: 'Worldwide edge CDN with custom domain CNAME support', icon: <Cloud className="w-4 h-4 text-amber-500" /> },
                    { id: 'vercel', name: 'Vercel Platform', desc: 'Modern frontend cloud with preview URLs', icon: <Rocket className="w-4 h-4 text-white" /> },
                    { id: 'netlify', name: 'Netlify', desc: 'Atomic deployments and CDN edge cache', icon: <Globe className="w-4 h-4 text-teal-400" /> },
                    { id: 'docker_container', name: 'Docker Container', desc: 'Linux container microservice for Kubernetes', icon: <Box className="w-4 h-4 text-blue-400" /> },
                    { id: 'custom_webhook', name: 'Custom Webhook / CI', desc: 'HMAC-SHA256 signed trigger to external runners', icon: <Webhook className="w-4 h-4 text-purple-400" /> }
                  ].map(p => (
                    <label
                      key={p.id}
                      className={`p-3 rounded-xl border flex items-start gap-3 cursor-pointer transition-all ${
                        selectedProvider === p.id
                          ? 'bg-amber-400/10 border-amber-400/60 text-white'
                          : 'bg-neutral-950/50 border-neutral-800/80 text-neutral-300 hover:border-neutral-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="provider"
                        value={p.id}
                        checked={selectedProvider === p.id}
                        onChange={() => setSelectedProvider(p.id as DeploymentProviderType)}
                        className="mt-1 text-amber-400 focus:ring-amber-400"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5 font-semibold text-sm">
                          {p.icon}
                          <span>{p.name}</span>
                        </div>
                        <p className="text-xs text-neutral-400 mt-0.5">{p.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Target Environment */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block">
                  Environment
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['production', 'staging', 'preview'] as DeploymentEnvironment[]).map(env => (
                    <button
                      key={env}
                      type="button"
                      onClick={() => setSelectedEnvironment(env)}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold uppercase border transition-all ${
                        selectedEnvironment === env
                          ? 'bg-amber-400 text-neutral-950 border-amber-400'
                          : 'bg-neutral-950 text-neutral-400 border-neutral-800 hover:text-white'
                      }`}
                    >
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              {/* Approval Gate Toggle */}
              <div className="pt-2 border-t border-neutral-800/80">
                <label className="flex items-start gap-2.5 cursor-pointer text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={skipApproval}
                    onChange={(e) => setSkipApproval(e.target.checked)}
                    className="mt-0.5 text-amber-400 rounded focus:ring-amber-400"
                  />
                  <div>
                    <span className="font-semibold text-white">Auto-approve deployment</span>
                    <p className="text-neutral-500 text-[11px] mt-0.5">
                      Bypass manual human gate if pre-deployment checks pass with 100% score.
                    </p>
                  </div>
                </label>
              </div>

              {/* Trigger Button */}
              <button
                onClick={handleTriggerDeploy}
                disabled={actionLoading}
                className="w-full py-2.5 px-4 rounded-xl bg-amber-400 hover:bg-amber-300 text-neutral-950 font-bold text-sm shadow-md transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {actionLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" />
                    <span>Deploy to {selectedProvider.replace('_', ' ').toUpperCase()}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PRE-DEPLOYMENT VALIDATION */}
      {activeTab === 'validation' && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-5">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Shield className="w-5 h-5 text-amber-400" />
                  Pre-Deployment Truthful Validation Scorecard
                </h3>
                <p className="text-sm text-neutral-400 mt-1">
                  Automated verification prevents broken, vulnerable, or unconfigured code from reaching production.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={fetchValidation}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Re-run Checks
                </button>
                <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-neutral-950 border border-neutral-800">
                  <span className="text-xs text-neutral-400 font-medium">Readiness:</span>
                  <span className={`text-base font-bold font-mono ${
                    validationResult && validationResult.passed ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {validationResult ? `${validationResult.readinessScore}/100` : 'Calculating...'}
                  </span>
                </div>
              </div>
            </div>

            {validationResult && (
              <div className="space-y-4">
                {/* Checks List */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {validationResult.checks.map((check, idx) => (
                    <div
                      key={idx}
                      className="p-4 rounded-xl bg-neutral-950 border border-neutral-800/80 flex items-start gap-3"
                    >
                      <div className="shrink-0 mt-0.5">
                        {check.status === 'passed' ? (
                          <CheckCircle className="w-5 h-5 text-emerald-400" />
                        ) : check.status === 'warning' ? (
                          <AlertTriangle className="w-5 h-5 text-amber-400" />
                        ) : (
                          <XCircle className="w-5 h-5 text-rose-400" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold text-white">{check.name}</h4>
                          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
                            {check.category}
                          </span>
                        </div>
                        <p className="text-xs text-neutral-300 mt-1">{check.message}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Defects Warning */}
                {validationResult.defects.length > 0 && (
                  <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-800/50 space-y-2">
                    <h4 className="text-xs font-bold text-rose-300 uppercase tracking-wider flex items-center gap-1.5">
                      <XCircle className="w-4 h-4 text-rose-400" />
                      Critical Defects Blocking Production
                    </h4>
                    <ul className="text-xs text-rose-200 list-disc list-inside space-y-1">
                      {validationResult.defects.map((def, idx) => (
                        <li key={idx}>{def}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Recommended Actions */}
                {validationResult.recommendedActions.length > 0 && (
                  <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-800 space-y-2">
                    <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                      Recommended Pre-Deploy Actions
                    </h4>
                    <ul className="text-xs text-neutral-300 list-disc list-inside space-y-1">
                      {validationResult.recommendedActions.map((act, idx) => (
                        <li key={idx}>{act}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: BUILD & DEPLOY LOGS */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-amber-400" />
                  Live Build & Deployment Log Stream
                </h3>
                <p className="text-xs text-neutral-400 mt-0.5 font-mono">
                  Release: {selectedDeployment ? selectedDeployment.id : 'None selected'}
                </p>
              </div>

              {/* Log Level Filter */}
              <div className="flex items-center gap-2">
                <Filter className="w-3.5 h-3.5 text-neutral-400" />
                <span className="text-xs text-neutral-400">Filter:</span>
                {(['all', 'info', 'warn', 'error', 'success'] as const).map(lvl => (
                  <button
                    key={lvl}
                    onClick={() => setLogFilter(lvl)}
                    className={`px-2.5 py-1 rounded text-xs font-mono uppercase transition-colors ${
                      logFilter === lvl
                        ? 'bg-amber-400 text-neutral-950 font-bold'
                        : 'bg-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            {/* Terminal Window */}
            <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-800 font-mono text-xs text-neutral-300 space-y-2 max-h-[500px] overflow-y-auto">
              {filteredLogs.length === 0 ? (
                <div className="py-8 text-center text-neutral-500">
                  No log entries matching filter "{logFilter}".
                </div>
              ) : (
                filteredLogs.map((log, idx) => (
                  <div key={idx} className="flex items-start gap-2.5 leading-relaxed">
                    <span className="text-neutral-500 text-[11px] shrink-0 font-mono">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`px-1.5 py-0.2 rounded text-[10px] uppercase font-bold shrink-0 ${
                      log.level === 'error' ? 'bg-rose-500/20 text-rose-400' :
                      log.level === 'warn' ? 'bg-amber-500/20 text-amber-400' :
                      log.level === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                      'bg-neutral-800 text-neutral-400'
                    }`}>
                      {log.level}
                    </span>
                    {log.phase && (
                      <span className="text-[10px] text-neutral-500 font-mono shrink-0">
                        [{log.phase}]
                      </span>
                    )}
                    <span className="break-all">{log.message}</span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: ENVIRONMENT & SECRETS */}
      {activeTab === 'secrets' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Secrets List */}
          <div className="lg:col-span-2 space-y-4">
            <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Lock className="w-5 h-5 text-amber-400" />
                    Encrypted Project Secrets
                  </h3>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    AES-256-GCM encrypted at rest. Injected securely into runtime containers and edge deployments.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded bg-neutral-800 text-neutral-300 text-xs font-mono">
                  {secrets.length} Secrets
                </span>
              </div>

              {secrets.length === 0 ? (
                <div className="py-8 text-center text-neutral-500">
                  No secrets configured. Add environment variables or API keys on the right.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {secrets.map(secret => (
                    <div
                      key={secret.id}
                      className="p-3.5 rounded-xl bg-neutral-950 border border-neutral-800 flex items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-amber-300">{secret.key}</span>
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-mono uppercase bg-neutral-800 text-neutral-400">
                            {secret.environment}
                          </span>
                        </div>
                        <div className="font-mono text-xs text-neutral-500">
                          {secret.maskedValue}
                        </div>
                      </div>

                      <button
                        onClick={() => handleDeleteSecret(secret.id)}
                        className="p-2 text-neutral-400 hover:text-rose-400 rounded-lg hover:bg-neutral-800 transition-colors"
                        title="Delete Secret"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Add Secret Form */}
          <div className="space-y-4">
            <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-amber-400" />
                Add Environment Secret
              </h3>

              <form onSubmit={handleAddSecret} className="space-y-3.5">
                <div>
                  <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1">
                    Key Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. DATABASE_URL or API_KEY"
                    value={newSecretKey}
                    onChange={(e) => setNewSecretKey(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-sm font-mono text-white focus:outline-none focus:border-amber-400"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1">
                    Secret Value
                  </label>
                  <input
                    type="password"
                    placeholder="Enter confidential value..."
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-sm font-mono text-white focus:outline-none focus:border-amber-400"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1">
                    Scope
                  </label>
                  <select
                    value={newSecretEnv}
                    onChange={(e) => setNewSecretEnv(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-sm text-white focus:outline-none focus:border-amber-400"
                  >
                    <option value="all">All Environments</option>
                    <option value="production">Production Only</option>
                    <option value="staging">Staging Only</option>
                    <option value="preview">Preview Only</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-amber-400 hover:bg-amber-300 text-neutral-950 font-bold text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Lock className="w-4 h-4" />
                  <span>Encrypt & Save Secret</span>
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: CUSTOM DOMAINS */}
      {activeTab === 'domains' && (
        <div className="max-w-3xl space-y-6">
          <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Globe className="w-5 h-5 text-amber-400" />
                Custom Domain Configuration
              </h3>
              <p className="text-sm text-neutral-400 mt-1">
                Attach your custom domain (e.g. app.yourdomain.com) to your production deployment with automatic SSL/TLS.
              </p>
            </div>

            <form onSubmit={handleConfigureDomain} className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. myapp.example.com"
                value={customDomainInput}
                onChange={(e) => setCustomDomainInput(e.target.value)}
                required
                className="flex-1 px-3.5 py-2.5 rounded-lg bg-neutral-950 border border-neutral-800 text-sm font-mono text-white focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={domainVerifying || !selectedDeployment}
                className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-neutral-950 font-semibold text-sm transition-colors shrink-0"
              >
                Configure Domain
              </button>
            </form>

            {/* Configured Domain Status */}
            {selectedDeployment && selectedDeployment.customDomain && (
              <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-neutral-500 uppercase block font-semibold">Configured Domain</span>
                    <span className="text-base font-mono font-bold text-amber-300">{selectedDeployment.customDomain}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                      selectedDeployment.customDomainStatus === 'active'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                    }`}>
                      {selectedDeployment.customDomainStatus === 'active' ? 'Verified & Active' : 'Pending DNS Propagation'}
                    </span>
                    <button
                      onClick={handleVerifyDomain}
                      disabled={domainVerifying}
                      className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors flex items-center gap-1"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${domainVerifying ? 'animate-spin' : ''}`} />
                      Verify DNS
                    </button>
                  </div>
                </div>

                {/* DNS Records Table */}
                {selectedDeployment.customDomainDnsRecords && selectedDeployment.customDomainDnsRecords.length > 0 && (
                  <div className="pt-2 border-t border-neutral-800 space-y-2">
                    <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block">
                      Required DNS Records
                    </span>
                    <div className="border border-neutral-800 rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-neutral-900/80 text-neutral-400 border-b border-neutral-800">
                          <tr>
                            <th className="p-2.5">Type</th>
                            <th className="p-2.5">Name / Host</th>
                            <th className="p-2.5">Value / Target</th>
                            <th className="p-2.5">TTL</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-800 text-neutral-300">
                          {selectedDeployment.customDomainDnsRecords.map((rec, i) => (
                            <tr key={i} className="hover:bg-neutral-900/40">
                              <td className="p-2.5 font-bold text-amber-400">{rec.type}</td>
                              <td className="p-2.5">{rec.name}</td>
                              <td className="p-2.5 text-white">{rec.value}</td>
                              <td className="p-2.5 text-neutral-500">{rec.ttl || 300}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: DEPLOYMENT HISTORY & ROLLBACK */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Layers className="w-5 h-5 text-amber-400" />
                  Chronological Deployment History
                </h3>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Inspect prior releases and perform instant atomic rollbacks.
                </p>
              </div>
              <span className="text-xs font-mono text-neutral-400">
                {deployments.length} Total Builds
              </span>
            </div>

            {deployments.length === 0 ? (
              <div className="py-8 text-center text-neutral-500">
                No deployments have been recorded yet.
              </div>
            ) : (
              <div className="space-y-3">
                {deployments.map(dep => (
                  <div
                    key={dep.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      selectedDeployment?.id === dep.id
                        ? 'bg-amber-400/5 border-amber-400/50'
                        : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        {getProviderIcon(dep.provider)}
                        <span className="font-bold text-sm text-white">{dep.provider.replace('_', ' ').toUpperCase()}</span>
                        <span className="text-xs font-mono text-amber-300">({dep.environment})</span>
                        {getStatusBadge(dep.status)}
                      </div>

                      <div className="flex items-center gap-4 text-xs font-mono text-neutral-400">
                        <span>Release: {dep.id.slice(0, 12)}...</span>
                        <span>Commit: {dep.commitSha ? dep.commitSha.slice(0, 8) : 'latest'}</span>
                        <span>Date: {new Date(dep.createdAt).toLocaleString()}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setSelectedDeployment(dep); setActiveTab('overview'); }}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
                      >
                        Details
                      </button>

                      {dep.status === 'active' && selectedDeployment?.id !== dep.id && (
                        <button
                          onClick={() => handleRollback(dep.id)}
                          disabled={actionLoading}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 transition-colors flex items-center gap-1.5"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Rollback Here
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
