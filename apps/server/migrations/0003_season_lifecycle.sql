-- Only one season may be active at a time. The lifecycle service also uses a
-- conditional update, so this is a durable final guard against concurrent
-- activation requests.
CREATE UNIQUE INDEX seasons_one_active ON seasons(state) WHERE state = 'active';
