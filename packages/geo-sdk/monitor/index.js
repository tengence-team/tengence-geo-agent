/**
 * monitor domain entry: t.monitor
 */

module.exports = {
  config: require('./config'),
  prompts: require('./prompts'),
  extract: require('./extract'),
  score: require('./score'),
  run: require('./run'),
  store: require('./store'),
};
