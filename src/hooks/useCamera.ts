import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'off' | 'starting' | 'on' | 'error';

/**
 * Optional live preview from the device camera. Detection stays simulated;
 * this only replaces the viewfinder background so demos feel real.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('off');
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError('This browser does not expose a camera.');
      return;
    }
    setState('starting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('on');
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState('error');
      setError(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Camera unavailable here.');
    }
  }, []);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return { videoRef, state, error, start, stop };
}
