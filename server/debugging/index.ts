import { executionManager } from '../execution/index.js';
import { RepairCoordinator } from './repairCoordinator.js';

export const repairCoordinator = new RepairCoordinator(executionManager);
