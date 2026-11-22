/**
 * TEST FIXTURES ONLY — used by `npm test` against the separate test database (TEST_DATABASE_URL).
 * The app itself ships empty: the first teacher creates everything from the setup screen.
 */
import bcrypt from 'bcryptjs';
import { q, one, tx } from '../src/db';
import { migrate } from '../src/db/migrate';
import { writeQuestion, type SaveQuestion } from '../src/services/questions';
import { loadQuestionSpec } from '../src/services/questions';
import { createRun } from '../src/services/runs';
import { referenceFiles } from '../src/services/grading';
import type { Lang } from '../src/services/runner';

const J = (a: string[]) => a.join('\n') + '\n';

const Q1: Omit<SaveQuestion, 'version'> = {
  type: 'code',
  title: 'BankAccount Class',
  difficulty: 'easy',
  points: 30,
  topic: 'Classes & encapsulation',
  languages: ['java', 'python'],
  instructionsMd: J([
    '### Overview',
    'Create a `BankAccount` class that stores an account number and a balance.',
    '### Requirements',
    '- `deposit(amount)` adds to the balance and rejects negative amounts with an error.',
    '- `withdraw(amount)` subtracts from the balance and returns `false` when funds are insufficient.',
    '- `getBalance()` (Python: `get_balance()`) returns the current balance.',
  ]),
  limits: { timeLimitMs: 2000, memoryLimitMb: 256, networkAccess: false },
  files: {
    java: {
      starter: [
        {
          path: 'BankAccount.java',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'public class BankAccount {',
            '    private final String accountNumber;',
            '    private double balance;',
            '',
            '    public BankAccount(String accountNumber, double openingBalance) {',
            '        this.accountNumber = accountNumber;',
            '        this.balance = openingBalance;',
            '    }',
            '',
            '    public void deposit(double amount) {',
            '        // TODO: reject negative amounts with IllegalArgumentException, then add to the balance',
            '    }',
            '',
            '    public boolean withdraw(double amount) {',
            '        // TODO: return false when funds are insufficient, otherwise subtract and return true',
            '        return false;',
            '    }',
            '',
            '    public double getBalance() {',
            '        return balance;',
            '    }',
            '}',
          ]),
        },
        {
          path: 'Main.java',
          readOnly: false,
          isEntrypoint: true,
          content: J([
            'public class Main {',
            '    public static void main(String[] args) {',
            '        BankAccount account = new BankAccount("ACC-0001", 500.0);',
            '        account.deposit(100.0);',
            '        System.out.println("Balance: " + account.getBalance());',
            '    }',
            '}',
          ]),
        },
      ],
      reference: [
        {
          path: 'BankAccount.java',
          content: J([
            'public class BankAccount {',
            '    private final String accountNumber;',
            '    private double balance;',
            '    public BankAccount(String accountNumber, double openingBalance) { this.accountNumber = accountNumber; this.balance = openingBalance; }',
            '    public void deposit(double amount) {',
            '        if (amount < 0) throw new IllegalArgumentException("Deposit must be positive");',
            '        balance += amount;',
            '    }',
            '    public boolean withdraw(double amount) {',
            '        if (amount > balance) return false;',
            '        balance -= amount;',
            '        return true;',
            '    }',
            '    public double getBalance() { return balance; }',
            '}',
          ]),
        },
      ],
      setup: 'BankAccount account = new BankAccount("ACC-0001", 500.0);',
      setupTarget: 'account',
    },
    python: {
      starter: [
        {
          path: 'bank_account.py',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'class BankAccount:',
            '    def __init__(self, account_number: str, opening_balance: float):',
            '        self.account_number = account_number',
            '        self._balance = opening_balance',
            '',
            '    def deposit(self, amount: float) -> None:',
            '        # TODO: raise ValueError for negative amounts, then add to the balance',
            '        pass',
            '',
            '    def withdraw(self, amount: float) -> bool:',
            '        # TODO: return False when funds are insufficient, otherwise subtract and return True',
            '        return False',
            '',
            '    def get_balance(self) -> float:',
            '        return self._balance',
          ]),
        },
        {
          path: 'main.py',
          readOnly: false,
          isEntrypoint: true,
          content: J(['from bank_account import BankAccount', '', 'account = BankAccount("ACC-0001", 500.0)', 'account.deposit(100.0)', 'print("Balance:", account.get_balance())']),
        },
      ],
      reference: [
        {
          path: 'bank_account.py',
          content: J([
            'class BankAccount:',
            '    def __init__(self, account_number, opening_balance):',
            '        self.account_number = account_number',
            '        self._balance = opening_balance',
            '    def deposit(self, amount):',
            '        if amount < 0:',
            '            raise ValueError("Deposit must be positive")',
            '        self._balance += amount',
            '    def withdraw(self, amount):',
            '        if amount > self._balance:',
            '            return False',
            '        self._balance -= amount',
            '        return True',
            '    def get_balance(self):',
            '        return self._balance',
          ]),
        },
      ],
      setup: 'account = BankAccount("ACC-0001", 500.0)',
      setupTarget: 'account',
    },
  },
  tests: [
    { name: 'Deposit increases the balance', kind: 'call', input: 'deposit(100.0)\njava: getBalance()\npython: get_balance()', expected: '600.0', matchType: 'exact', floatTolerance: 0.01, weight: 10, hidden: false, sortOrder: 0 },
    { name: 'Negative deposit is rejected', kind: 'call', input: 'deposit(-5.0)', expected: 'IllegalArgumentException|ValueError', matchType: 'exception_class', floatTolerance: 0.01, weight: 10, hidden: false, sortOrder: 1 },
    { name: 'Withdraw beyond balance returns false', kind: 'call', input: 'withdraw(900.0)', expected: 'false', matchType: 'exact', floatTolerance: 0.01, weight: 10, hidden: true, sortOrder: 2 },
  ],
};

const Q2: Omit<SaveQuestion, 'version'> = {
  type: 'code',
  title: 'Banking Account Inheritance Hierarchy',
  difficulty: 'intermediate',
  points: 40,
  topic: 'Inheritance & polymorphism',
  languages: ['java', 'python'],
  instructionsMd: J([
    '### Overview',
    'Design the abstract base class `Account` and the subclass `SavingsAccount` that conforms to the specification below.',
    '### Requirements',
    '- `Account` must declare abstract methods `deposit(double amount)` and `withdraw(double amount)`.',
    '- In `SavingsAccount`, enforce a minimum opening balance of **$50.00** and apply interest with `applyMonthlyInterest()` (Python: `apply_monthly_interest()`).',
    '- Throw `InsufficientFundsException` (Python: raise `InsufficientFundsError`) when a withdrawal exceeds available funds.',
  ]),
  limits: { timeLimitMs: 2000, memoryLimitMb: 256, networkAccess: false },
  files: {
    java: {
      starter: [
        {
          path: 'Account.java',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            '// Fixture question 2',
            'package com.example.banking;',
            '',
            'import java.util.Objects;',
            '',
            '/** Abstract blueprint for all transactional account entities. */',
            'public abstract class Account {',
            '    protected final String accountNumber;',
            '    protected double balance;',
            '',
            '    public Account(String accountNumber, double initialDeposit) {',
            '        if (initialDeposit < 0.0) {',
            '            throw new IllegalArgumentException("Opening balance cannot be negative");',
            '        }',
            '        this.accountNumber = Objects.requireNonNull(accountNumber);',
            '        this.balance = initialDeposit;',
            '    }',
            '',
            '    public abstract boolean withdraw(double amount) throws InsufficientFundsException;',
            '    public abstract void deposit(double amount);',
            '',
            '    public double getBalance() {',
            '        return this.balance;',
            '    }',
            '}',
          ]),
        },
        {
          path: 'SavingsAccount.java',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'package com.example.banking;',
            '',
            'public class SavingsAccount extends Account {',
            '    private final double interestRate;',
            '',
            '    public SavingsAccount(String accountNumber, double initialDeposit, double interestRate) {',
            '        super(accountNumber, initialDeposit);',
            '        if (initialDeposit < 50.0) {',
            '            throw new IllegalArgumentException("Minimum opening balance is $50.00");',
            '        }',
            '        this.interestRate = interestRate;',
            '    }',
            '',
            '    @Override',
            '    public void deposit(double amount) {',
            '        balance += amount;',
            '    }',
            '',
            '    @Override',
            '    public boolean withdraw(double amount) throws InsufficientFundsException {',
            '        if (amount > balance) {',
            '            return false; // TODO: handle overdraft as the spec says',
            '        }',
            '        balance -= amount;',
            '        return true;',
            '    }',
            '',
            '    public void applyMonthlyInterest() {',
            '        balance += balance * interestRate;',
            '    }',
            '}',
          ]),
        },
        {
          path: 'InsufficientFundsException.java',
          readOnly: true,
          isEntrypoint: false,
          content: J(['package com.example.banking;', '', 'public class InsufficientFundsException extends Exception {', '    public InsufficientFundsException(String message) {', '        super(message);', '    }', '}']),
        },
      ],
      reference: [
        {
          path: 'SavingsAccount.java',
          content: J([
            'package com.example.banking;',
            'public class SavingsAccount extends Account {',
            '    private final double interestRate;',
            '    public SavingsAccount(String accountNumber, double initialDeposit, double interestRate) {',
            '        super(accountNumber, initialDeposit);',
            '        if (initialDeposit < 50.0) throw new IllegalArgumentException("Minimum opening balance is $50.00");',
            '        this.interestRate = interestRate;',
            '    }',
            '    @Override public void deposit(double amount) { balance += amount; }',
            '    @Override public boolean withdraw(double amount) throws InsufficientFundsException {',
            '        if (amount > balance) throw new InsufficientFundsException("Insufficient funds");',
            '        balance -= amount;',
            '        return true;',
            '    }',
            '    public void applyMonthlyInterest() { balance += balance * interestRate; }',
            '}',
          ]),
        },
      ],
      setup: 'SavingsAccount account = new SavingsAccount("ACC-0001", 500.0, 0.005);',
      setupTarget: 'account',
    },
    python: {
      starter: [
        {
          path: 'account.py',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'from abc import ABC, abstractmethod',
            '',
            '',
            'class InsufficientFundsError(Exception):',
            '    """Raised when a withdrawal exceeds available funds."""',
            '',
            '',
            'class Account(ABC):',
            '    def __init__(self, account_number: str, initial_deposit: float):',
            '        if initial_deposit < 0:',
            '            raise ValueError("Opening balance cannot be negative")',
            '        self.account_number = account_number',
            '        self._balance = initial_deposit',
            '',
            '    @abstractmethod',
            '    def withdraw(self, amount: float) -> bool: ...',
            '',
            '    @abstractmethod',
            '    def deposit(self, amount: float) -> None: ...',
            '',
            '    def get_balance(self) -> float:',
            '        return self._balance',
          ]),
        },
        {
          path: 'savings_account.py',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'from account import Account, InsufficientFundsError',
            '',
            '',
            'class SavingsAccount(Account):',
            '    def __init__(self, account_number: str, initial_deposit: float, interest_rate: float):',
            '        if initial_deposit < 50:',
            '            raise ValueError("Minimum opening balance is $50.00")',
            '        super().__init__(account_number, initial_deposit)',
            '        self.interest_rate = interest_rate',
            '',
            '    def deposit(self, amount: float) -> None:',
            '        self._balance += amount',
            '',
            '    def withdraw(self, amount: float) -> bool:',
            '        if amount > self._balance:',
            '            return False  # TODO: handle overdraft as the spec says',
            '        self._balance -= amount',
            '        return True',
            '',
            '    def apply_monthly_interest(self) -> None:',
            '        self._balance += self._balance * self.interest_rate',
          ]),
        },
      ],
      reference: [
        {
          path: 'savings_account.py',
          content: J([
            'from account import Account, InsufficientFundsError',
            'class SavingsAccount(Account):',
            '    def __init__(self, account_number, initial_deposit, interest_rate):',
            '        if initial_deposit < 50:',
            '            raise ValueError("Minimum opening balance is $50.00")',
            '        super().__init__(account_number, initial_deposit)',
            '        self.interest_rate = interest_rate',
            '    def deposit(self, amount):',
            '        self._balance += amount',
            '    def withdraw(self, amount):',
            '        if amount > self._balance:',
            '            raise InsufficientFundsError("Insufficient funds")',
            '        self._balance -= amount',
            '        return True',
            '    def apply_monthly_interest(self):',
            '        self._balance += self._balance * self.interest_rate',
          ]),
        },
      ],
      setup: 'account = SavingsAccount("ACC-0001", 500.0, 0.005)',
      setupTarget: 'account',
    },
  },
  tests: [
    { name: 'Standard deposit and balance', kind: 'call', input: 'deposit(100.0)\njava: getBalance()\npython: get_balance()', expected: '600.0', matchType: 'float_tolerance', floatTolerance: 0.01, weight: 15, hidden: false, sortOrder: 0 },
    { name: 'Overdraft throws an exception', kind: 'call', input: 'withdraw(700.0)', expected: 'InsufficientFundsException|InsufficientFundsError', matchType: 'exception_class', floatTolerance: 0.01, weight: 15, hidden: false, sortOrder: 1 },
    { name: 'Interest accrual rate', kind: 'call', input: 'java: applyMonthlyInterest()\npython: apply_monthly_interest()\njava: getBalance()\npython: get_balance()', expected: '502.5', matchType: 'float_tolerance', floatTolerance: 0.01, weight: 10, hidden: true, sortOrder: 2 },
  ],
};

const Q3: Omit<SaveQuestion, 'version'> = {
  type: 'code',
  title: 'Student Record Serializer',
  difficulty: 'intermediate',
  points: 30,
  topic: 'File I/O & serialization',
  languages: ['java'],
  instructionsMd: J([
    '### Overview',
    'Save a list of `StudentRecord` objects to a text file and load them back.',
    '### Requirements',
    '- `write(records, file)` writes one record per line as `id,name,score`.',
    '- `read(file)` returns the records in the same order.',
    '- Use UTF-8 so names like `Đặng Test` keep their accents.',
  ]),
  limits: { timeLimitMs: 2000, memoryLimitMb: 256, networkAccess: false },
  files: {
    java: {
      starter: [
        {
          path: 'RecordSerializer.java',
          readOnly: false,
          isEntrypoint: false,
          content: J([
            'import java.io.*;',
            'import java.nio.charset.StandardCharsets;',
            'import java.nio.file.*;',
            'import java.util.*;',
            '',
            'public class RecordSerializer {',
            '',
            '    /** Write one record per line as: id,name,score */',
            '    public static void write(List<StudentRecord> records, Path file) throws IOException {',
            '        // TODO: write each record to the file',
            '        throw new UnsupportedOperationException("Not implemented yet");',
            '    }',
            '',
            '    /** Read the records back in the same order. */',
            '    public static List<StudentRecord> read(Path file) throws IOException {',
            '        // TODO: read the file and rebuild each record',
            '        throw new UnsupportedOperationException("Not implemented yet");',
            '    }',
            '}',
          ]),
        },
        { path: 'StudentRecord.java', readOnly: true, isEntrypoint: false, content: 'public record StudentRecord(String id, String name, double score) {}\n' },
      ],
      reference: [
        {
          path: 'RecordSerializer.java',
          content: J([
            'import java.io.*;',
            'import java.nio.charset.StandardCharsets;',
            'import java.nio.file.*;',
            'import java.util.*;',
            'public class RecordSerializer {',
            '    public static void write(List<StudentRecord> records, Path file) throws IOException {',
            '        try (BufferedWriter w = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {',
            '            for (StudentRecord r : records) { w.write(r.id() + "," + r.name() + "," + r.score()); w.newLine(); }',
            '        }',
            '    }',
            '    public static List<StudentRecord> read(Path file) throws IOException {',
            '        List<StudentRecord> out = new ArrayList<>();',
            '        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {',
            '            if (line.isBlank()) continue;',
            '            String[] p = line.split(",");',
            '            out.add(new StudentRecord(p[0], p[1], Double.parseDouble(p[2])));',
            '        }',
            '        return out;',
            '    }',
            '}',
          ]),
        },
      ],
      setup: 'java.nio.file.Path file = java.nio.file.Files.createTempFile("records", ".csv");\njava.util.List<StudentRecord> records = java.util.List.of(new StudentRecord("S1", "Test Student One", 75.0), new StudentRecord("S2", "Đặng Test", 88.0));',
      setupTarget: '',
    },
  },
  tests: [
    { name: 'Write then read returns the same records', kind: 'call', input: 'RecordSerializer.write(records, file)\nRecordSerializer.read(file).equals(records)', expected: 'true', matchType: 'exact', floatTolerance: 0.01, weight: 20, hidden: false, sortOrder: 0 },
    { name: 'Names with accents survive a round trip', kind: 'call', input: 'RecordSerializer.write(records, file)\nRecordSerializer.read(file).get(1).name()', expected: 'Đặng Test', matchType: 'exact', floatTolerance: 0.01, weight: 10, hidden: true, sortOrder: 1 },
  ],
};

const STUDENTS: [string, string, string][] = [
  ['S0001', 'Test Student One', 'FX101-A'],
  ['S0002', 'Test Student Two', 'FX101-A'],
  ['S0003', 'Test Student Three', 'FX101-B'],
  ['S0004', 'Test Student Four', 'FX101-B'],
  ['S0005', 'Test Student Five', 'FX101-C'],
  ['S0006', 'Test Student Six', 'FX101-C'],
  ['S0007', 'Test Student Seven', 'FX101-A'],
  ['S0008', 'Test Student Eight', 'FX101-B'],
];

export async function seed() {
  await migrate();
  await q(`TRUNCATE users, terms, courses, questions, exams, audit_events, notifications, validation_jobs, outbound_emails CASCADE`);
  const teacherPw = await bcrypt.hash('teacher12345', 10);
  const studentPw = await bcrypt.hash('student12345', 10);

  const ids = await tx(async (c) => {
    const teacher = await one(`INSERT INTO users(role, email, full_name, display_name, title, password_hash, password_set_at) VALUES ('teacher','teacher@test.local','Test Teacher','Test Teacher','Lecturer',$1, now()) RETURNING id`, [teacherPw], c);
    await q(`INSERT INTO users(role, email, full_name, display_name, password_hash, password_set_at) VALUES ('teacher','teacher2@test.local','Second Teacher','Second Teacher',$1, now())`, [teacherPw], c);
    const term = await one(`INSERT INTO terms(name, starts_on, ends_on) VALUES ('Test Term', current_date - 60, current_date + 60) RETURNING id`, [], c);
    const fx101 = await one(`INSERT INTO courses(term_id, code, title, department) VALUES ($1,'FX101','Fixture Course','Testing') RETURNING id`, [term.id], c);
    const fx100 = await one(`INSERT INTO courses(term_id, code, title, department) VALUES ($1,'FX100','Fixture Course Two','Testing') RETURNING id`, [term.id], c);
    for (const co of [fx101.id, fx100.id]) await q(`INSERT INTO course_teachers(course_id, teacher_id) VALUES ($1,$2)`, [co, teacher.id], c);
    const classes: Record<string, string> = {};
    for (const code of ['FX101-A', 'FX101-B', 'FX101-C', 'FX101-D']) classes[code] = (await one(`INSERT INTO classes(course_id, code) VALUES ($1,$2) RETURNING id`, [fx101.id, code], c)).id;
    classes['FX100-A'] = (await one(`INSERT INTO classes(course_id, code) VALUES ($1,'FX100-A') RETURNING id`, [fx100.id], c)).id;
    const students: Record<string, string> = {};
    for (const [sid, name, cls] of STUDENTS) {
      const email = name.toLowerCase().replace(/[^a-z]+/g, '.') + '@students.test.local';
      const u = await one(`INSERT INTO users(role, email, student_id, full_name, password_hash, password_set_at) VALUES ('student',$1,$2,$3,$4, now()) RETURNING id`, [email, sid, name, studentPw], c);
      students[sid] = u.id;
      await q(`INSERT INTO enrollments(class_id, student_id) VALUES ($1,$2)`, [classes[cls], u.id], c);
      await q(`INSERT INTO enrollments(class_id, student_id) VALUES ($1,$2)`, [classes['FX100-A'], u.id], c);
    }
    // a lab session for the schedule-conflict warning (tomorrow 09:00-09:30 UTC)
    await q(`INSERT INTO class_sessions(class_id, label, starts_at, ends_at) VALUES ($1,'lab session', date_trunc('day', now()) + interval '1 day 9 hours', date_trunc('day', now()) + interval '1 day 9 hours 30 minutes')`, [classes['FX101-B']], c);

    const qids: string[] = [];
    for (const def of [Q1, Q2, Q3]) {
      const qrow = await one(`INSERT INTO questions(course_id, owner_id, last_edited_by) VALUES ($1,$2,$2) RETURNING id`, [fx101.id, teacher.id], c);
      await writeQuestion(qrow.id, { ...def, version: 1 }, teacher.id, c);
      qids.push(qrow.id);
    }
    return { teacher: teacher.id, fx101: fx101.id, fx100: fx100.id, classes, students, qids };
  });

  // Validate every reference solution now (also proves the runner works on this machine).
  for (const qid of ids.qids) {
    const { spec, row } = (await loadQuestionSpec(qid))!;
    const job = await one(`INSERT INTO validation_jobs(question_id, requested_by, version) VALUES ($1,$2,$3) RETURNING id`, [qid, ids.teacher, row.version]);
    for (const l of spec.languages) {
      const runId = await createRun({ kind: 'reference_validation', requestedBy: ids.teacher, language: l as Lang, files: referenceFiles(spec, l as Lang), spec, questionId: qid, validationJobId: job.id });
      let r: any;
      for (let i = 0; i < 240; i++) {
        r = await one(`SELECT status, tests_passed, tests_total FROM code_runs WHERE id = $1`, [runId]);
        if (!['queued', 'running'].includes(r.status)) break;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      console.log(`[fixtures] validate ${spec.title} (${l}): ${r.status} ${r.tests_passed}/${r.tests_total}`);
    }
  }

  await tx(async (c) => {
    const snap = async (qid: string) => JSON.stringify((await loadQuestionSpec(qid, c))!.spec);
    // Live midterm: started 2 minutes ago, open for late join.
    const mid = await one(
      `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, instructions_md, status, starts_at, duration_minutes, late_join_minutes, published_at)
       VALUES ($1,$2,'FX101 Fixture Exam','FX Exam','midterm',$3,'live', now() - interval '2 minutes', 90, 15, now() - interval '1 day') RETURNING id`,
      [ids.fx101, ids.teacher, 'You have 90 minutes to complete 3 coding questions. You may use any of the allowed languages for each question. Run the sample tests as often as you like — hidden tests run after you submit. Your work is auto-saved every 10 seconds.'],
      c,
    );
    for (const cl of ['FX101-A', 'FX101-B', 'FX101-C']) await q(`INSERT INTO exam_classes(exam_id, class_id) VALUES ($1,$2)`, [mid.id, ids.classes[cl]], c);
    await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,'java'),($1,'python')`, [mid.id], c);
    const pts = [30, 40, 30];
    for (const [i, qid] of ids.qids.entries()) {
      await q(`INSERT INTO exam_questions(exam_id, source_question_id, source_version, position, points, snapshot, snapshotted_at) VALUES ($1,$2,2,$3,$4,$5, now())`, [mid.id, qid, i + 1, pts[i], await snap(qid)], c);
    }
    await q(`INSERT INTO exam_accommodations(exam_id, student_id, extra_minutes) VALUES ($1,$2,30),($1,$3,15)`, [mid.id, ids.students['S0006'], ids.students['S0004']], c);

    // Draft final, to walk through the create-exam wizard.
    const fin = await one(
      `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, instructions_md, status, starts_at, duration_minutes, late_join_minutes)
       VALUES ($1,$2,'FX101 Fixture Draft','FX Draft','final','Answer both questions. Hidden tests run after you submit.','draft', date_trunc('day', now()) + interval '1 day 9 hours', 120, 15) RETURNING id`,
      [ids.fx101, ids.teacher],
      c,
    );
    for (const cl of ['FX101-A', 'FX101-B']) await q(`INSERT INTO exam_classes(exam_id, class_id) VALUES ($1,$2)`, [fin.id, ids.classes[cl]], c);
    await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,'java'),($1,'python')`, [fin.id], c);
    for (const [i, qid] of ids.qids.slice(0, 2).entries()) {
      await q(`INSERT INTO exam_questions(exam_id, source_question_id, position, points, snapshot) VALUES ($1,$2,$3,$4,$5)`, [fin.id, qid, i + 1, i === 0 ? 40 : 60, await snap(qid)], c);
    }

    // Practice sandbox (no SEB, never graded).
    const pr = await one(
      `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, status, is_practice, duration_minutes, seb_required, instructions_md)
       VALUES ($1,$2,'Practice sandbox','Practice sandbox','practice','live',true,180,false,'Try the exam editor before the real thing.') RETURNING id`,
      [ids.fx101, ids.teacher],
      c,
    );
    await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,'java'),($1,'python')`, [pr.id], c);
    await q(`INSERT INTO exam_questions(exam_id, source_question_id, position, points, snapshot, snapshotted_at) VALUES ($1,$2,1,30,$3, now())`, [pr.id, ids.qids[0], await snap(ids.qids[0]!)], c);

    await q(
      `INSERT INTO audit_events(actor_id, actor_label, actor_role, category, action, exam_id, course_id, target_label, details)
       VALUES ($1,'Test Teacher','Teacher','publish','exam.published',$2,$3,'FX Exam','Published to FX101-A, FX101-B, FX101-C · 8 students notified')`,
      [ids.teacher, mid.id, ids.fx101],
      c,
    );
  });
  console.log('[fixtures] ready');
}


