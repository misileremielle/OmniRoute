import fs from "node:fs";

const target = process.argv[1];

fs.stat(target, (err) => {
  if (err) process.exit(3);
  fs.stat(target, (err2) => {
    if (err2) process.exit(4);
    fs.readFile(target, (err3) => {
      if (err3) process.exit(5);
    });
  });
});
