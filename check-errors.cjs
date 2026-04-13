const { execSync } = require('child_process');
const result = execSync('npx tsx --no-cache -e "' + 
  "const { db } = require('./server/db'); console.log('ok')" +
'"').toString();
console.log(result);
