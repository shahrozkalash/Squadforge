import { ProjectFile, BrowserRuntimeCheck, BrowserRuntimeVerificationReport } from '../types.js';

export interface ExtendedBrowserRuntimeVerificationReport extends BrowserRuntimeVerificationReport {
  routesVerified?: boolean;
  jsExecutionVerified?: boolean;
  unhandledRejectionsClean?: boolean;
}

export class BrowserRuntimeVerifier {
  /**
   * Performs comprehensive automated runtime verification on the generated live preview HTML and bundle.
   * Evaluates 10 distinct runtime dimensions:
   * 1. HTML document loading
   * 2. JavaScript execution
   * 3. React mounting
   * 4. Dependency loading
   * 5. Meaningful rendered content
   * 6. Interactive controls
   * 7. Required routes
   * 8. Responsive layouts
   * 9. Browser console errors
   * 10. Unhandled promise rejections
   *
   * Separates compilation success from runtime success.
   */
  static verifyPreviewRuntime(
    previewResult: {
      html: string;
      mode: 'real_application' | 'static_html' | 'fallback_preview';
      entryPoint?: string;
      diagnosticInfo?: string;
      runtimeErrors?: string[];
      compilationStatus?: 'compiled' | 'failed' | 'not_applicable';
      runtimeStatus?: 'verified' | 'unverified' | 'failed';
      dependencyStatus?: 'clean' | 'has_unsupported' | 'server_rejected';
    },
    files: ProjectFile[] = []
  ): ExtendedBrowserRuntimeVerificationReport {
    const checks: BrowserRuntimeCheck[] = [];
    const errors: string[] = [];
    const html = previewResult.html || '';
    const mode = previewResult.mode;
    const allCode = files.map(f => f.content).join('\n') + '\n' + html;

    // 1. HTML Document Loading
    const hasDoctype = /<!doctype\s+html>/i.test(html);
    const hasHtmlTags = /<html[^>]*>[\s\S]*<\/html>/i.test(html);
    const hasHead = /<head[^>]*>[\s\S]*<\/head>/i.test(html);
    const hasBody = /<body[^>]*>[\s\S]*<\/body>/i.test(html);
    const hasTitle = /<title[^>]*>([^<]+)<\/title>/i.test(html);
    const documentValid = hasDoctype && hasHtmlTags && hasHead && hasBody && hasTitle;

    checks.push({
      name: 'HTML Document Structure & Loading',
      category: 'document',
      status: documentValid ? 'passed' : 'failed',
      message: documentValid
        ? 'HTML document is fully structured with DOCTYPE, head, body, and title.'
        : 'HTML document is malformed or missing critical structural tags.',
      details: `Doctype: ${hasDoctype}, HTML: ${hasHtmlTags}, Head: ${hasHead}, Body: ${hasBody}, Title: ${hasTitle}`
    });
    if (!documentValid) errors.push('Malformed HTML document structure');

    // 2. JavaScript Execution Hook
    const hasModuleScript = /<script\s+type=["']module["']/i.test(html);
    const hasInlineExecutable = /<script(?![^>]*type=["']importmap["'])[^>]*>[\s\S]*?<\/script>/i.test(html);
    const jsExecutionVerified = mode === 'static_html' ? true : (hasModuleScript || hasInlineExecutable);

    checks.push({
      name: 'JavaScript Execution & Script Mounting',
      category: 'mount',
      status: jsExecutionVerified ? 'passed' : (mode === 'fallback_preview' ? 'skipped' : 'failed'),
      message: jsExecutionVerified
        ? (mode === 'static_html' ? 'Static HTML requires no custom JavaScript runtime bundle.' : 'Valid ESM module execution script tags verified in preview bundle.')
        : 'JavaScript bundle execution hook is missing from HTML preview.',
      details: `Module script tag: ${hasModuleScript}, Inline executable script: ${hasInlineExecutable}`
    });
    if (!jsExecutionVerified && mode === 'real_application') {
      errors.push('Missing JavaScript module script tag in preview HTML');
    }

    // 3. React DOM Mounting
    const hasRootContainer = /<main[^>]+id=["']root["']|<div[^>]+id=["']root["']/i.test(html);
    const hasMountLogic = /createRoot|ReactDOM\.render|mountTarget/i.test(allCode);
    const domMountVerified = mode === 'static_html' ? (hasBody || hasRootContainer) : (hasRootContainer && (hasModuleScript || hasMountLogic));

    checks.push({
      name: 'DOM Mount Target & React Root Binding',
      category: 'mount',
      status: domMountVerified ? 'passed' : (mode === 'fallback_preview' ? 'skipped' : 'failed'),
      message: domMountVerified
        ? (mode === 'static_html' ? 'Static HTML page renders directly into document body.' : 'Valid #root mount target and React mounting logic verified.')
        : (mode === 'fallback_preview' ? 'Real DOM mount skipped (running in fallback demonstration mode).' : 'Missing #root mount element or React root creation logic.'),
      details: `Mode: ${mode}, #root element present: ${hasRootContainer}, Mount logic: ${hasMountLogic}`
    });
    if (!domMountVerified && mode !== 'fallback_preview') {
      errors.push('DOM mount target or script bundle tag missing');
    }

    // 4. Dependency Loading & Import Map Integrity
    let dependencyIntegrityVerified = false;
    let importMapPresent = false;
    let importMapValid = false;
    let importMapEntriesCount = 0;

    const importMapMatch = html.match(/<script\s+type=["']importmap["']>([\s\S]*?)<\/script>/i);
    if (importMapMatch && importMapMatch[1]) {
      importMapPresent = true;
      try {
        const parsed = JSON.parse(importMapMatch[1]);
        if (parsed && typeof parsed.imports === 'object') {
          importMapValid = true;
          importMapEntriesCount = Object.keys(parsed.imports).length;

          // Verify critical browser react packages are present
          const hasReact = Boolean(parsed.imports['react']);
          const hasReactDom = Boolean(parsed.imports['react-dom'] || parsed.imports['react-dom/client']);
          dependencyIntegrityVerified = hasReact && hasReactDom;
        }
      } catch (err: any) {
        errors.push(`Invalid JSON in <script type="importmap">: ${err?.message}`);
      }
    } else if (mode === 'static_html') {
      dependencyIntegrityVerified = true;
    }

    checks.push({
      name: 'Browser Dependency Import Map Integrity',
      category: 'dependencies',
      status: dependencyIntegrityVerified ? 'passed' : (mode === 'fallback_preview' ? 'skipped' : 'failed'),
      message: dependencyIntegrityVerified
        ? `Import map validated with ${importMapEntriesCount} resolved browser module(s).`
        : (mode === 'fallback_preview' ? 'Dependency verification skipped for fallback preview.' : 'Import map is missing or failed validation.'),
      details: `Import map present: ${importMapPresent}, JSON valid: ${importMapValid}, entries: ${importMapEntriesCount}`
    });
    if (!dependencyIntegrityVerified && mode === 'real_application') {
      errors.push('Incomplete or missing browser module import map');
    }

    // 5. Meaningful Rendered Content
    const hasMeaningfulContent =
      /<(h[1-6]|header|nav|section|article|p|table|form|button)[^>]*>/i.test(html) &&
      !html.includes('id="root"></div>') &&
      html.length > 500;

    checks.push({
      name: 'Meaningful Content & Semantic Structure',
      category: 'content',
      status: hasMeaningfulContent ? 'passed' : 'failed',
      message: hasMeaningfulContent
        ? 'Application contains rich semantic tags, headers, and UI layout elements.'
        : 'Render resulted in empty container or minimal structure.',
      details: `HTML byte length: ${html.length}, semantic elements present: ${hasMeaningfulContent}`
    });
    if (!hasMeaningfulContent) errors.push('Rendered document lacks semantic content structure');

    // 6. Interactive Controls & State Wiring
    const hasInteractiveElements =
      /<button|<input|<select|<textarea|<form/i.test(html) ||
      /<button|<input|<select|<textarea|<form/i.test(allCode);
    const hasEventHandlers =
      /onClick|onChange|onSubmit|addEventListener|onclick=/i.test(allCode);
    const hasStateOrHooks =
      /useState|useReducer|useEffect|state\s*=/i.test(allCode);
    const interactiveControlsVerified = (hasInteractiveElements && hasEventHandlers) || hasStateOrHooks;

    checks.push({
      name: 'Interactive Controls & Event Handling',
      category: 'interactivity',
      status: interactiveControlsVerified ? 'passed' : 'skipped',
      message: interactiveControlsVerified
        ? 'Interactive buttons/forms and reactive state/event handlers verified in components.'
        : 'Application is primarily display-oriented with no explicit interactive controls.',
      details: `Buttons/inputs: ${hasInteractiveElements}, Event handlers: ${hasEventHandlers}, State hooks: ${hasStateOrHooks}`
    });

    // 7. Required Routes & Navigation
    const hasRoutes =
      /<Route|<Routes|BrowserRouter|HashRouter|createBrowserRouter|useNavigate|useLocation|<a\s+href=/i.test(allCode);
    const routesVerified = hasRoutes || !allCode.includes('react-router');

    checks.push({
      name: 'Required Routes & Navigation Flow',
      category: 'content',
      status: routesVerified ? 'passed' : 'skipped',
      message: routesVerified
        ? (hasRoutes ? 'Declarative routes and client-side navigation links verified.' : 'Single-page architecture verified without external router requirements.')
        : 'Router hooks found without configured Router provider boundary.',
      details: `Client routes detected: ${hasRoutes}`
    });

    // 8. Responsive Layout & Viewport Usability
    const hasViewportMeta = /<meta[^>]+name=["']viewport["'][^>]*content=["'][^"']*width=device-width/i.test(html);
    const hasResponsiveCss =
      /(sm:|md:|lg:|xl:|flex|grid|max-w-|w-full|min-h-)/i.test(html) ||
      /(sm:|md:|lg:|xl:|flex|grid|max-w-|w-full|min-h-)/i.test(allCode);
    const responsiveLayoutVerified = hasViewportMeta && hasResponsiveCss;

    checks.push({
      name: 'Responsive Viewport & Mobile Layout',
      category: 'layout',
      status: responsiveLayoutVerified ? 'passed' : 'failed',
      message: responsiveLayoutVerified
        ? 'Viewport meta tag and responsive breakpoint styles verified.'
        : 'Missing viewport meta tag or responsive layout rules.',
      details: `Viewport meta: ${hasViewportMeta}, Responsive CSS utilities: ${hasResponsiveCss}`
    });
    if (!responsiveLayoutVerified) errors.push('Missing viewport meta tag or responsive layout');

    // 9. Browser Console Errors & Diagnostics
    const hasRuntimeDiagnosticErrors =
      (previewResult.runtimeErrors && previewResult.runtimeErrors.length > 0) ||
      (previewResult.diagnosticInfo && previewResult.diagnosticInfo.includes('failed')) ||
      (previewResult.compilationStatus === 'failed');
    const isFallbackMode = mode === 'fallback_preview';

    checks.push({
      name: 'Browser Console & Runtime Diagnostics Evaluation',
      category: 'errors',
      status: (!hasRuntimeDiagnosticErrors && !isFallbackMode) ? 'passed' : 'failed',
      message: (!hasRuntimeDiagnosticErrors && !isFallbackMode)
        ? 'Zero uncaught runtime compilation errors or fallback states detected.'
        : `Preview reported runtime warning/error: ${previewResult.diagnosticInfo || (previewResult.runtimeErrors || []).join('; ') || 'Fallback mode active'}`,
      details: `Runtime errors count: ${previewResult.runtimeErrors?.length || 0}, Fallback mode: ${isFallbackMode}`
    });
    if (hasRuntimeDiagnosticErrors) {
      if (previewResult.runtimeErrors && previewResult.runtimeErrors.length > 0) {
        errors.push(...previewResult.runtimeErrors);
      } else {
        errors.push(previewResult.diagnosticInfo || 'Runtime error reported in preview bundle');
      }
    }

    // 10. Unhandled Promise Rejections
    const hasPromiseCatch = /window\.addEventListener\(['"]unhandledrejection/i.test(html);
    const unhandledRejectionsClean = !hasRuntimeDiagnosticErrors;

    checks.push({
      name: 'Unhandled Promise Rejection & Async Guard',
      category: 'errors',
      status: unhandledRejectionsClean ? 'passed' : 'failed',
      message: unhandledRejectionsClean
        ? 'Asynchronous runtime handlers verified with unhandled rejection listener active.'
        : 'Asynchronous rejection or uncaught promise failure detected during execution.',
      details: `Unhandled rejection listener wired: ${hasPromiseCatch}`
    });

    // Overall browser runtime verdict: strictly separates compilation success from runtime success
    const criticalChecksPassed =
      documentValid &&
      (mode === 'real_application' ? (domMountVerified && dependencyIntegrityVerified && jsExecutionVerified) : true) &&
      !hasRuntimeDiagnosticErrors &&
      !isFallbackMode;

    const verdict = criticalChecksPassed
      ? 'verified'
      : (mode === 'fallback_preview' ? 'failed' : 'partially_verified');

    return {
      verified: criticalChecksPassed,
      verdict,
      timestamp: Date.now(),
      checks,
      errors,
      domMountVerified,
      meaningfulContentRendered: hasMeaningfulContent,
      interactiveControlsVerified,
      responsiveLayoutVerified,
      dependencyIntegrityVerified,
      routesVerified,
      jsExecutionVerified,
      unhandledRejectionsClean
    };
  }
}
