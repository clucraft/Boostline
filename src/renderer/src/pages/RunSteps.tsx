import { Fragment } from 'react'
import { CheckIcon } from '../components/icons'

/** Set up → capture → results progress shown on the Dyno and Drag pages. */
export function RunSteps({ step, labels }: { step: number; labels: string[] }) {
  return (
    <div className="stepper">
      {labels.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && <span className="step-line" />}
          <span className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
            <span className="num">{i < step ? <CheckIcon size={11} weight="bold" /> : i + 1}</span>
            {label}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
