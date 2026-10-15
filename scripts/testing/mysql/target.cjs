function localTestTarget(env) {
  if (env.QED_TEST_MYSQL_CONFIRM !== 'SYNTHETIC_LOCAL_ONLY' ||
      env.QED_TEST_MYSQL_HOST !== '127.0.0.1' ||
      env.QED_TEST_MYSQL_PORT !== '3307' ||
      env.QED_TEST_MYSQL_DATABASE !== 'qed_release_test' ||
      env.QED_TEST_MYSQL_USER !== 'qed_test' ||
      typeof env.QED_TEST_MYSQL_PASSWORD !== 'string' || !env.QED_TEST_MYSQL_PASSWORD) {
    throw new Error('Refusing unapproved target: require the exact loopback synthetic MySQL fixture.');
  }
  return { host: '127.0.0.1', port: 3307, database: 'qed_release_test', user: 'qed_test',
    password: env.QED_TEST_MYSQL_PASSWORD, timezone: '+08:00', dateStrings: true, connectionLimit: 4 };
}
module.exports = { localTestTarget };
