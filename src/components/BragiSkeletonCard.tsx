import type { AslStatus } from '../lib/bridge';

interface Props {
  asl: AslStatus;
}

/** The exact normalized skeleton image Bragi's CNN classifies, under the camera. */
export function BragiSkeletonCard({ asl }: Props) {
  return (
    <section className="card bragi__model-view" aria-label="AI view">
      <span className="eyebrow">AI view · skeleton</span>
      <div className="bragi__skeleton">
        {asl.skeleton_image ? (
          <img src={asl.skeleton_image} alt="Normalized hand skeleton seen by the ASL model" />
        ) : (
          <span>{asl.classifier === 'cnn' ? 'Waiting for a hand' : 'The AI view is the CNN’s input: switch to CNN to see it'}</span>
        )}
      </div>
    </section>
  );
}
