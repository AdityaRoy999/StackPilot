from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class Actor:
    runtime: object
    run_id: str
    agent_id: str
    user_id: str
    attempt: int = 0
    owner: str = ''

    @property
    def lead(self):
        return self.agent_id == 'lead'


actor_context = ContextVar('stackpilot_agent_actor', default=None)
