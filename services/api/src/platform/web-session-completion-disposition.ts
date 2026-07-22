export const webSessionCompletionAcceptedSQL = `(
  EXISTS (
    SELECT 1
    FROM identity.web_session_completion_outcomes AS completion_outcome
    JOIN identity.web_session_completion_dispositions AS completion_disposition
      ON completion_disposition.attempt_hash = completion_outcome.attempt_hash
     AND completion_disposition.challenge_id = completion_outcome.challenge_id
     AND completion_disposition.device_id = completion_outcome.device_id
     AND completion_disposition.binding_id = completion_outcome.binding_id
     AND completion_disposition.binding_generation = completion_outcome.binding_generation
     AND completion_disposition.session_id = completion_outcome.session_id
    WHERE completion_outcome.session_id = session.id
      AND completion_disposition.state = 'accepted'
  )
  OR (
    NOT EXISTS (
      SELECT 1
      FROM identity.web_session_completion_outcomes AS completion_outcome
      WHERE completion_outcome.session_id = session.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM identity.web_session_completion_dispositions AS completion_disposition
      WHERE completion_disposition.session_id = session.id
    )
  )
)`;
