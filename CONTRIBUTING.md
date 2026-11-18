# Contributing

Issues and pull requests are welcome.

- **Before a large change, open an issue.** It saves you building something that does not fit.
- **Run `npm run check`** before you open a pull request. CI runs the same command.
- **Keep the promises each package makes.** `jq-groundcrew` sends nothing off your machine; its build fails if the bundle names a network call. A change that needs the network belongs in a different package.
- **No personal data in code, tests or fixtures.** Use placeholder paths such as `/Users/x/project`.
- **Licence.** By contributing you agree your contribution is licensed under Apache-2.0, as section 5 of the licence says. No separate agreement is needed.

Security problem? Please do not open a public issue. Use GitHub's "Report a vulnerability" on this repository.
