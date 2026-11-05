// Runs in its own process, so slow checks never hold up the server. Project code is only read here.
import { AutomaticRepairEngine } from '../swarm/automaticRepairEngine.js';
import { IntegrationAgent } from '../swarm/integrationAgent.js';
import { DiagnosticCollector } from './diagnosticCollector.js';

function perform(request: any) {
  if (request.task === 'dimensions') return AutomaticRepairEngine.evaluateValidationDimensions(request.files, request.contracts);
  if (request.task === 'integration') return IntegrationAgent.analyzeProjectContracts(request.files);
  return DiagnosticCollector.collectStatic(request.buildId, request.files, request.contracts);
}

process.on('message', (request: any) => {
  try {
    process.send!({ id: request.id, result: perform(request) });
  } catch (err: any) {
    process.send!({ id: request.id, error: err.message || 'Checks failed' });
  }
});

process.on('disconnect', () => process.exit(0));
