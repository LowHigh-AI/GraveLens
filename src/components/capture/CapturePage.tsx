"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import BrandLogo from "@/components/ui/BrandLogo";
import PageShell from "@/components/layout/PageShell";
import { useAuth } from "@/lib/auth";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { fileToDataUrl, extractExifLocation, correctOrientation, generateId } from "@/lib/exif";
import { savePendingResult, addToQueue, getQueueCount } from "@/lib/storage";
import { QUEUE_CHANGED_EVENT } from "@/lib/queue";
import { reverseGeocode } from "@/lib/apis/nominatim";
import { getDeviceLocation } from "@/lib/geo";
import { takePendingCaptureFile } from "@/lib/pendingCapture";
import { SCAN_USAGE } from "@/lib/usageActions";
import type { ExtractedGraveData, GeoLocation } from "@/types";
import { localContrastBoost, unsharpMask } from "@/lib/relief";
import { resizeForStorage, generateThumbnail, saveToDevice } from "@/lib/imageUtils";
import OnboardingCarousel from "@/components/onboarding/OnboardingCarousel";
import CommunityConsentModal from "@/components/onboarding/CommunityConsentModal";
import { loadSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings";

type Phase = "idle" | "processing" | "queued" | "degraded_prompt";

export default function CapturePage() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Scanning is the core AI/cloud feature, so it requires a LowHigh login.
  // We read auth through a ref so a tap during the brief auth-loading window
  // never falsely redirects an already-signed-in user. Local browsing of the
  // saved archive stays open to signed-out users elsewhere in the app.
  const authRef = useRef({ user, loading: authLoading });
  authRef.current = { user, loading: authLoading };
  const requireAuthForScan = useCallback(() => {
    const auth = authRef.current;
    if (!auth.loading && !auth.user) {
      router.push("/login?next=/");
      return false;
    }
    return true;
  }, [router]);

  const [settings, setSettings] = useState(() => loadSettings());
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const onSettingsChanged = () => {
      setSettings(loadSettings());
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    };
  }, []);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [queueReason, setQueueReason] = useState<"offline" | "rate_limited" | null>(null);

  const analysisDataRef = useRef<{ extracted: ExtractedGraveData | null, location: GeoLocation | null } | null>(null);

  // Prevents stale analyses from saving and cancels in-flight fetches
  const analysisNonceRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // One usage id per scan, shared by the marker read (/api/analyze) and the
  // cultural summary the result page auto-loads, so both log under one
  // "Scan a marker" action. Persisted onto the pending record for the handoff.
  const scanPromptIdRef = useRef<string | null>(null);


  // Offline detection
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );

  // Reset scroll on mount + track connectivity + auto-open camera if flagged
  useEffect(() => {
    window.scrollTo(0, 0);
    const onOnline  = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);

    // BottomNav camera FAB chose a file from another page — process it immediately
    const pending = takePendingCaptureFile();
    if (pending) {
      handleFileChosen(pending);
    }

    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // BottomNav camera FAB tapped while already on this page
  useEffect(() => {
    const handler = () => {
      if (phase === "idle") {
        if (!requireAuthForScan()) return;
        cameraInputRef.current?.click();
      }
    };
    window.addEventListener("gravelens:open-camera", handler);
    return () => window.removeEventListener("gravelens:open-camera", handler);
  }, [phase, requireAuthForScan]);

  // Keep the screen awake while the user is on this page
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl = (navigator as any).wakeLock;
    let mounted = true;
    let lock: WakeLockSentinel | null = null;

    const acquire = async () => {
      if (!mounted || document.visibilityState !== "visible") return;
      try {
        lock = await wl.request("screen");
        // Re-acquire if the browser releases the lock unexpectedly (battery saver, etc.)
        lock!.addEventListener("release", () => {
          if (mounted && document.visibilityState === "visible") acquire();
        });
      } catch {
        // Device denied (low battery, permissions, etc.) — silently skip
      }
    };

    // Browsers release the lock when the page is hidden; re-acquire on return
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      lock?.release().catch(() => {});
    };
  }, []);

  const handleFileChosen = useCallback(async (file: File) => {
    // Gate the whole scan funnel on login — covers camera, file picker, drag-drop,
    // and the pending-capture handoff from the BottomNav FAB.
    if (!requireAuthForScan()) return;

    // Invalidate any in-flight analysis for the previous photo
    analysisNonceRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    const raw = await fileToDataUrl(file);
    const dataUrl = await correctOrientation(file, raw);
    setPreviewUrl(dataUrl);
    setSelectedFile(file);
    setPhase("processing");
    setProgress(10);
    setProgressLabel("Reading image…");
  }, [requireAuthForScan]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedFile || !previewUrl) return;

    // Snapshot the nonce at the start — if it changes, a newer photo was taken
    const nonce = analysisNonceRef.current;
    // Fresh usage id for this scan (shared with the cultural summary auto-loaded
    // on the result page) so the whole scan sums to one "Scan a marker" action.
    scanPromptIdRef.current = crypto.randomUUID();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setPhase("processing");
    setProgress(10);
    setProgressLabel("Reading image…");

    try {
      // ── Parallel phase ──────────────────────────────────────────────────
      setProgress(20);
      setProgressLabel("Analyzing marker…");

      const [preprocessed, exifLoc] = await Promise.all([
        preprocessAndResize(previewUrl),
        extractExifLocation(selectedFile),
      ]);

      if (analysisNonceRef.current !== nonce) return; // newer photo was taken

      // EXIF GPS is stripped by most mobile browsers — fall back to device location
      const gpsLoc = exifLoc ?? await getDeviceLocation();
      const geocodePromise = gpsLoc ? reverseGeocode(gpsLoc.lat, gpsLoc.lng) : Promise.resolve(null);

      // ── Claude analysis ─────────────────────────────────────────────────
      setProgress(40);
      let extracted: ExtractedGraveData | null = null;

      try {
        const claudeRes = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: preprocessed.base64,
            mimeType: preprocessed.mimeType,
            promptId: scanPromptIdRef.current,
            ...SCAN_USAGE,
          }),
          signal: controller.signal,
        });

        if (claudeRes.ok) {
          const { extracted: claudeExtracted, _model } = await claudeRes.json();
          if (claudeExtracted) {
            extracted = claudeExtracted;
            if (_model && _model.includes("sonnet")) {
              setProgressLabel("Enhanced analysis complete…");
            }
          }
        } else if (claudeRes.status === 429 || claudeRes.status >= 500) {
          // Rate limited (429) or a transient backend error (5xx): queue the
          // capture and let the user keep scanning. The queue retries once the
          // backend recovers, instead of silently degrading to a low-confidence
          // local scan. Other 4xx (e.g. 402 out-of-tokens, 400) intentionally
          // fall through to the local OCR path below rather than retry forever.
          await handleQueueCapture("rate_limited");
          return;
        } else {
          const errorData = await claudeRes.json().catch(() => ({}));
          console.warn("Claude API returned", claudeRes.status, errorData.details ?? "");
        }
      } catch (claudeErr) {
        if (claudeErr instanceof Error && claudeErr.name === "AbortError") return; // photo changed
        console.warn("Claude request failed:", claudeErr);
      }

      if (analysisNonceRef.current !== nonce) return; // newer photo was taken

      // ── Tesseract fallback (only if Claude completely failed) ───────────
      if (!extracted) {
        setProgressLabel("Reading inscription locally…");
        try {
          const { runTesseract } = await import("@/lib/ocr");
          const ocr = await runTesseract(selectedFile);
          extracted = buildFromOcr(ocr.text);
          extracted.confidence = "low";
        } catch {
          extracted = buildFromOcr("");
          extracted.confidence = "low";
        }
      }

      if (analysisNonceRef.current !== nonce) return; // newer photo was taken

      // ── Await geocode result (likely already done) ──────────────────────
      setProgress(80);
      setProgressLabel("Finding location…");
      const location = await geocodePromise;

      const isPoorQuality = !extracted || extracted.confidence === "low" || !extracted.name;

      if (isPoorQuality) {
        analysisDataRef.current = { extracted, location };
        setPhase("degraded_prompt");
        return;
      }

      await saveCurrentAnalysis(extracted, location, previewUrl, selectedFile);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("CapturePage: Analysis failed:", err instanceof Error ? err.message : err);
      setPhase("idle");
    }
  }, [selectedFile, previewUrl, router]);

  const saveCurrentAnalysis = useCallback(async (
    dataOrRef: ExtractedGraveData | null, 
    locOrRef: GeoLocation | null,
    pUrl: string | null = previewUrl,
    sFile: File | null = selectedFile
  ) => {
    if (!sFile || !pUrl) return;
    try {
      setPhase("processing");
      setProgress(90);
      setProgressLabel("Saving…");

      const storageDataUrl = await resizeForStorage(pUrl);
      const [thumbnailDataUrl] = await Promise.all([
        generateThumbnail(storageDataUrl),
        settings.photoSaveTarget === "app-and-device"
          ? saveToDevice(storageDataUrl, `gravelens-${Date.now()}.jpg`)
          : Promise.resolve(),
      ]);
      const id = generateId();
      await savePendingResult(id, {
        id,
        photoDataUrl: storageDataUrl,
        thumbnailDataUrl,
        extracted: dataOrRef,
        location: locOrRef,
        timestamp: Date.now(),
        scanPromptId: scanPromptIdRef.current ?? undefined,
      });
      setProgress(100);
      router.push(`/result/${id}`);
    } catch (err) {
      console.error("CapturePage: Save failed:", err);
      setPhase("idle");
    }
  }, [previewUrl, selectedFile, router]);

  // Auto-analyze as soon as a file is chosen
  useEffect(() => {
    if (phase === "processing" && selectedFile && previewUrl) {
      if (isOffline) {
        handleQueueCapture();
      } else {
        handleAnalyze();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, selectedFile, previewUrl]);

  const handleReset = useCallback(() => {
    setPhase("idle");
    setPreviewUrl(null);
    setSelectedFile(null);
    setProgress(0);
    setQueueReason(null);
  }, []);


  const handleQueueCapture = useCallback(async (reason?: "offline" | "rate_limited") => {
    if (!selectedFile || !previewUrl) return;

    setQueueReason(reason ?? "offline");
    setPhase("processing");
    setProgress(20);
    setProgressLabel(reason === "rate_limited" ? "Busy — adding to queue…" : "Saving to queue…");

    try {
      const exifLoc = await extractExifLocation(selectedFile);
      // EXIF GPS is stripped by most mobile browsers — fall back to device location
      const gpsLoc = exifLoc ?? await getDeviceLocation();
      let location: GeoLocation | undefined;

      if (gpsLoc) {
        setProgress(40);
        const geocoded = await reverseGeocode(gpsLoc.lat, gpsLoc.lng).catch(() => null);
        location = (geocoded ?? gpsLoc) as GeoLocation;
      }

      setProgress(70);
      const storageDataUrl = await resizeForStorage(previewUrl);
      const [thumbnailDataUrl] = await Promise.all([
        generateThumbnail(storageDataUrl),
        settings.photoSaveTarget === "app-and-device"
          ? saveToDevice(storageDataUrl, `gravelens-${Date.now()}.jpg`)
          : Promise.resolve(),
      ]);

      const id = generateId();
      await addToQueue({
        id,
        timestamp: Date.now(),
        photoDataUrl: storageDataUrl,
        thumbnailDataUrl,
        location,
        status: "pending",
        retries: 0,
      });

      window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
      setProgress(100);
      setPhase("queued");
      setTimeout(() => handleReset(), 1400);
    } catch (err) {
      console.error("CapturePage: Queue capture failed:", err instanceof Error ? err.message : err);
      setPhase("idle");
    }
  }, [selectedFile, previewUrl, handleReset]);

  return (
    <PageShell
      showLogo={true}
      customMainClasses="items-center px-5 pb-28"
      backgroundClass="bg-transparent"
    >
      <OnboardingCarousel />
      <CommunityConsentModal />
      {/* Main content */}
      <>
        {phase === "idle" && (
          isDesktop ? (
            <DesktopIdleState
              onUpload={() => { if (requireAuthForScan()) fileInputRef.current?.click(); }}
              onFileDrop={(file) => handleFileChosen(file)}
              signedOut={!authLoading && !user}
            />
          ) : (
            <IdleState
              onUpload={() => { if (requireAuthForScan()) fileInputRef.current?.click(); }}
              onCapture={() => { if (requireAuthForScan()) cameraInputRef.current?.click(); }}
              showTips={settings.showPhotoTips}
              signedOut={!authLoading && !user}
            />
          )
        )}
        {phase === "degraded_prompt" && (
          <DegradedPrompt
            onManualEnter={() => {
              const data = analysisDataRef.current?.extracted || null;
              const loc = analysisDataRef.current?.location || null;
              saveCurrentAnalysis(data, loc);
            }}
            onDelete={handleReset}
          />
        )}
        {phase === "processing" && previewUrl && (
          <div className="flex-1 flex flex-col items-center justify-center w-full">
            <ProcessingState
              previewUrl={previewUrl}
              progress={progress}
              label={progressLabel}
            />
          </div>
        )}
        {phase === "queued" && (
          <div className="flex-1 flex flex-col items-center justify-center w-full">
            <QueuedConfirmation reason={queueReason} />
          </div>
        )}
      </>

      {/* Hidden file inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file);
          e.target.value = "";
        }}
      />
    </PageShell>
  );
}

// ── Queue link ──────────────────────────────────────────────────────────────

function QueueLink() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    getQueueCount().then(setCount);
    const handler = () => getQueueCount().then(setCount);
    window.addEventListener(QUEUE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, handler);
  }, []);

  if (count === 0) return null;

  return (
    <Link
      href="/queue"
      className="flex items-center justify-center gap-1.5 text-sm text-stone-400 hover:text-stone-200 active:text-stone-200 transition-colors py-1"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      Queue · {count} pending
    </Link>
  );
}

// ── Idle state ─────────────────────────────────────────────────────────────

const PHOTO_TIPS = [
  { icon: "☁️", text: "Overcast light or open shade — direct sun creates harsh shadows" },
  { icon: "📐", text: "Shoot straight-on, not from an angle" },
  { icon: "🔲", text: "Fill the frame — the inscription should be the whole photo" },
  { icon: "💧", text: "Wetting a dry stone with water can sharpen contrast" },
];

function ViewfinderGraphic({ dragging = false, desktop = false }: { dragging?: boolean; desktop?: boolean }) {
  return (
    <div className={`relative flex items-center justify-center w-[200px] h-[200px] sm:w-64 sm:h-64 ${desktop ? "lg:w-80 lg:h-80" : ""} flex-shrink-0 transition-transform ${dragging ? "scale-[1.02]" : ""}`}>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 256 256">
        {/* Corner brackets — pulse on mobile, stay still on the calmer desktop hero */}
        <g className={desktop ? "" : "motion-safe:animate-pulse-slow"}>
          <path d="M32 80 L32 32 L80 32" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          <path d="M176 32 L224 32 L224 80" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          <path d="M32 176 L32 224 L80 224" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          <path d="M176 224 L224 224 L224 176" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
        </g>
      </svg>

      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        {/* Central focal point */}
        <div className="relative translate-y-[1px]">
          {/* Outer glow ring — breathes on mobile, calm on desktop (anti-slop) */}
          <div className={`absolute inset-0 -m-8 rounded-full bg-[var(--t-gold-500)]/5 blur-2xl ${desktop ? "" : "motion-safe:animate-pulse"}`} />

          {/* Logo with drop shadow for depth — lighter, directional shadow on desktop */}
          <div className={`relative scale-90 sm:scale-110 ${desktop ? "lg:scale-125 drop-shadow-[0_2px_12px_rgba(201,168,76,0.28)]" : "drop-shadow-[0_0_15px_rgba(201,168,76,0.5)]"}`}>
            <BrandLogo size={100} color="var(--t-gold-500)" />
          </div>
        </div>

        {/* Status text */}
        <div className={`absolute bottom-0 sm:bottom-2 left-1/2 -translate-x-1/2 ${desktop ? "" : "motion-safe:animate-pulse-slow"}`}>
          <span className={`${dragging ? "text-[var(--t-gold-500)]" : "text-[var(--t-gold-500)]/80"} text-[0.7rem] sm:text-xs font-bold tracking-[0.4em] whitespace-nowrap uppercase`}>
            {dragging ? "Drop to scan" : "Ready to scan"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Shared idle hero (mobile camera + desktop upload/drag-drop) ──────────────

function IdleHero({
  variant,
  onPrimary,
  onUpload,
  onFileDrop,
  showTips = true,
  signedOut = false,
}: {
  variant: "mobile" | "desktop";
  onPrimary: () => void;
  onUpload: () => void;
  onFileDrop?: (file: File) => void;
  showTips?: boolean;
  signedOut?: boolean;
}) {
  const desktop = variant === "desktop";
  const [tipsOpen, setTipsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      onFileDrop?.(file);
    }
  }, [onFileDrop]);

  // Desktop is the only variant that accepts dropped files (no camera).
  const dragHandlers = desktop
    ? {
        onDragOver: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(true); },
        onDragLeave: () => setDragging(false),
        onDrop: handleDrop,
      }
    : {};

  const actionIcon = signedOut ? (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
      <polyline points="10 17 15 12 10 7"/>
      <line x1="15" y1="12" x2="3" y2="12"/>
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );

  return (
    <div
      {...dragHandlers}
      className={
        desktop
          ? `flex flex-col items-center w-full max-w-sm lg:max-w-md mx-auto animate-fade-in flex-1 justify-center lg:-translate-y-4 rounded-3xl transition-colors ${dragging ? "bg-[var(--t-gold-500)]/[0.03]" : ""}`
          : "flex flex-col items-center w-full max-w-sm mx-auto animate-fade-in flex-1 pt-2 pb-0 sm:pb-4 justify-between"
      }
      style={desktop ? undefined : { paddingBottom: "env(safe-area-inset-bottom, 16px)" }}
    >
      {/* Graphic + text */}
      <div className={`flex flex-col items-center justify-center gap-4 ${desktop ? "lg:gap-6" : ""} pt-2`}>
        <button
          onClick={onPrimary}
          aria-label={desktop ? "Upload a grave photo to analyze" : "Open camera to scan a headstone"}
          className="group relative flex items-center justify-center flex-shrink-0 active:scale-95 transition-transform touch-none select-none rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          <ViewfinderGraphic dragging={dragging} desktop={desktop} />
        </button>

        <div className="flex flex-col items-center gap-2 text-center px-2">
          <h1 className={`font-serif text-2xl sm:text-3xl ${desktop ? "lg:text-4xl" : ""} font-semibold text-stone-100 leading-tight`}>
            Bring the story behind every stone into focus.
          </h1>
          <p className="text-stone-400 text-sm sm:text-lg leading-relaxed">
            Photograph any headstone and experience history like never before.
          </p>
          {desktop && (
            <p className="text-stone-500 text-xs mt-1">
              Drop a photo anywhere, or use the button below.
            </p>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className={`flex flex-col items-center gap-3 w-full pt-4 ${desktop ? "lg:pt-6" : "mt-auto mb-28"}`}>
        {/* Tips toggle (mobile only — desktop users already took their photo) */}
        {showTips && <button
          onClick={() => setTipsOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs text-stone-500 active:text-stone-300 transition-colors py-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Tips for better scans
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: tipsOpen ? "rotate(0deg)" : "rotate(180deg)", transition: "transform 0.2s" }}
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>}

        {/* Tips panel */}
        {showTips && tipsOpen && (
          <div
            className="w-full rounded-2xl p-4 flex flex-col gap-2.5 animate-fade-in"
            style={{ background: "rgba(201,168,76,0.05)", border: "1px solid rgba(201,168,76,0.15)" }}
          >
            {PHOTO_TIPS.map((tip) => (
              <div key={tip.text} className="flex items-start gap-2.5">
                <span className="text-sm mt-px leading-none">{tip.icon}</span>
                <span className="text-xs text-stone-400 leading-relaxed">{tip.text}</span>
              </div>
            ))}
          </div>
        )}

        {desktop ? (
          <button
            onClick={onUpload}
            className="flex items-center justify-center gap-3 w-full h-12 rounded-2xl font-semibold text-base transition-all active:scale-[0.97] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            style={{ background: "linear-gradient(135deg, #c9a84c 0%, #a07830 100%)", color: "#1a1917" }}
          >
            {actionIcon}
            {signedOut ? "Sign In to use GraveLens AI" : "Browse Files"}
          </button>
        ) : (
          <button
            onClick={onUpload}
            className="flex items-center justify-center gap-3 w-full h-12 rounded-2xl border border-stone-600 text-stone-200 font-medium text-base transition-all active:scale-[0.97] bg-stone-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--t-gold-500)]"
          >
            {actionIcon}
            {signedOut ? "Sign In to use GraveLens AI" : "Upload from Library"}
          </button>
        )}

        {signedOut && (
          <p className="text-xs text-stone-400 text-center px-4">
            You&apos;ll sign in with a free LowHigh account to scan. Browsing your saved archive stays free.
          </p>
        )}

        {desktop && (
          <p className="text-stone-400 text-xs text-center">
            Supports JPG, PNG, HEIC · EXIF GPS extracted automatically
          </p>
        )}

        <QueueLink />

        <Link
          href="/research"
          className="block text-center text-xs text-stone-400 hover:text-stone-200 transition-colors underline underline-offset-4 decoration-stone-600"
        >
          Research a name — no photo needed
        </Link>
      </div>
    </div>
  );
}

// ── Idle state wrappers ──────────────────────────────────────────────────────

function IdleState({
  onUpload,
  onCapture,
  showTips = true,
  signedOut = false,
}: {
  onUpload: () => void;
  onCapture: () => void;
  showTips?: boolean;
  signedOut?: boolean;
}) {
  return (
    <IdleHero
      variant="mobile"
      onPrimary={onCapture}
      onUpload={onUpload}
      showTips={showTips}
      signedOut={signedOut}
    />
  );
}

// ── Desktop idle state (file upload / drag-and-drop) ────────────────────────

function DesktopIdleState({ onUpload, onFileDrop, signedOut = false }: { onUpload: () => void; onFileDrop: (file: File) => void; signedOut?: boolean }) {
  return (
    <IdleHero
      variant="desktop"
      onPrimary={onUpload}
      onUpload={onUpload}
      onFileDrop={onFileDrop}
      showTips={false}
      signedOut={signedOut}
    />
  );
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function DegradedPrompt({ onManualEnter, onDelete }: { onManualEnter: () => void, onDelete: () => void }) {
  return (
    <div className="flex flex-col items-center w-full max-w-sm mx-auto animate-fade-in flex-1 justify-center px-4 text-center mt-auto mb-auto">
      <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500 flex items-center justify-center mb-6">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <h2 className="font-serif text-2xl font-semibold text-stone-100 mb-4">Scan Failed</h2>
      <p className="text-stone-300 text-lg leading-relaxed mb-10">
        The quality of the memorial is too degraded and we were unable to analyze it automatically. 
      </p>
      
      <div className="flex flex-col gap-4 w-full">
        <button onClick={onManualEnter} className="w-full py-4 rounded-xl bg-stone-700 text-white font-medium shadow-md">Manually Enter Details</button>
        <button onClick={onDelete} className="w-full py-4 rounded-xl bg-red-600/20 border border-red-600/50 text-red-500 font-medium">Delete Image</button>
      </div>
    </div>
  );
}

// ── Queued confirmation ─────────────────────────────────────────────────────

function QueuedConfirmation({ reason }: { reason: "offline" | "rate_limited" | null }) {
  return (
    <div className="flex flex-col items-center gap-4 animate-fade-in text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-stone-800 border border-stone-700 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <div>
        <p className="text-stone-100 font-semibold text-base">Saved to queue</p>
        <p className="text-stone-500 text-sm mt-1">
          {reason === "rate_limited"
            ? "Keep scanning — this will process automatically in a moment."
            : "Will analyze automatically when back online."}
        </p>
      </div>
    </div>
  );
}

// ── Preview state ───────────────────────────────────────────────────────────



// ── Processing state ────────────────────────────────────────────────────────

function ProcessingState({
  previewUrl,
  progress,
  label,
}: {
  previewUrl: string;
  progress: number;
  label: string;
}) {
  return (
    <div className="flex flex-col w-full max-w-sm gap-6 animate-fade-in pt-4">
      <div className="relative rounded-2xl overflow-hidden bg-stone-800 aspect-[3/4] w-full shadow-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={previewUrl}
          alt="Analyzing"
          className="w-full h-full object-cover opacity-40"
        />
        {/* Scan line animation */}
        <div
          className="absolute left-0 right-0 h-0.5 transition-all duration-700"
          style={{
            top: `${progress}%`,
            background: "linear-gradient(90deg, transparent, var(--t-gold-500), transparent)",
            boxShadow: "0 0 8px var(--t-gold-500)",
          }}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex justify-between text-xs text-stone-400">
          <span>{label}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1 bg-stone-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${progress}%`,
              background: "linear-gradient(90deg, #5c7a5c, var(--t-gold-500))",
            }}
          />
        </div>
      </div>

      <p className="text-stone-500 text-xs text-center">
        Searching historical records & public archives…
      </p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compress a photo for long-term storage in IndexedDB.
 * Keeps the longest edge ≤ 1200 px at 80% JPEG quality.
 * A typical 3–8 MB phone photo becomes ~100–250 KB — safe for IndexedDB
 * and resistant to browser storage eviction on low-storage devices.
 * 1200 px is sharp enough to read inscriptions at full-screen mobile width.
 *
 * To upgrade to cloud storage later, replace this function's output with
 * an upload call and store the returned URL instead of the data URL.
 * See CLOUD_STORAGE_GUIDE.md for the recommended migration path.
 */

/**
 * Preprocess an image for Claude: contrast stretch → CLAHE-lite → unsharp mask → resize.
 * Keeps the longest edge ≤ 1568 px (Claude's native max) at 78% JPEG quality.
 * The three-step pipeline matches the Relief Lens processing path and significantly
 * improves legibility on weathered, faded, or low-contrast stone engravings.
 */
function preprocessAndResize(
  dataUrl: string,
  maxPx = 1568,
  quality = 0.78
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unavailable"));
      ctx.drawImage(img, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // ── 1. Global contrast stretch ────────────────────────────────────────
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (luma < min) min = luma;
        if (luma > max) max = luma;
      }
      const range = max - min || 1;
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = Math.min(255, ((data[i]     - min) / range) * 255);
        data[i + 1] = Math.min(255, ((data[i + 1] - min) / range) * 255);
        data[i + 2] = Math.min(255, ((data[i + 2] - min) / range) * 255);
      }

      // ── 2. CLAHE-lite: local contrast boost (8×8 tile grid) ───────────────
      localContrastBoost(data, w, h);

      // ── 3. Unsharp mask (0.5 strength) ────────────────────────────────────
      unsharpMask(data, w, h, 0.5);

      ctx.putImageData(imageData, 0, 0);
      const resized = canvas.toDataURL("image/jpeg", quality);
      resolve({ base64: resized.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = () => reject(new Error("Failed to load image for Claude preprocessing"));
    img.src = dataUrl;
  });
}

function buildFromOcr(text: string): ExtractedGraveData {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const yearRegex = /\b(1[7-9]\d{2}|20\d{2})\b/g;
  const years: number[] = [];
  text.replace(yearRegex, (_, y) => {
    years.push(parseInt(y));
    return _;
  });
  years.sort((a, b) => a - b);

  const birthYear = years[0] ?? null;
  const deathYear = years[years.length - 1] ?? null;
  const ageAtDeath =
    birthYear && deathYear && deathYear > birthYear
      ? deathYear - birthYear
      : null;

  const nameLine =
    lines.find(
      (l) => /^[A-Z][a-zA-Z\s'-]+$/.test(l) && l.length > 3 && l.length < 60
    ) ?? "";

  const parts = nameLine.trim().split(/\s+/);

  return {
    name: nameLine,
    firstName: parts[0] ?? "",
    lastName: parts[parts.length - 1] ?? "",
    birthDate: birthYear ? String(birthYear) : "",
    birthYear,
    deathDate: deathYear ? String(deathYear) : "",
    deathYear,
    ageAtDeath,
    inscription: text,
    epitaph: "",
    symbols: [],
    markerType: "headstone",
    material: "unknown",
    condition: "unknown",
    confidence: "low",
    source: "tesseract",
  };
}
