const MAX_ACCOUNT_ID = 18446744073709551615n;

export function canonicalAccountID(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 1) return null;
        value = String(value);
    }
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)
        || BigInt(value) > MAX_ACCOUNT_ID) return null;
    return value;
}

export function accountWriteError(code = 'account_changed') {
    const error = new Error('Your account changed. Refresh this page before saving.');
    error.status = 409;
    error.body = { error: code };
    error.payload = error.body;
    return error;
}

export function isAccountWriteError(error) {
    return ['account_changed', 'account_identity_required'].includes(error?.payload?.error ?? error?.body?.error);
}

export function assertAccountWriteOwner(actualUserID, expectedUserID) {
    const actual = canonicalAccountID(actualUserID);
    if (!actual) {
        const error = accountWriteError('authentication_required');
        error.status = 401;
        throw error;
    }
    if (typeof expectedUserID !== 'string' || canonicalAccountID(expectedUserID) !== expectedUserID) {
        throw accountWriteError('account_identity_required');
    }
    if (actual !== expectedUserID) throw accountWriteError();
}

export function requireAccountWriteOwner(req, _res, next) {
    try {
        assertAccountWriteOwner(req.session?.userID, req.body?.expectedUserID);
        // Identity metadata belongs to transport, not the strict business payload.
        const body = { ...req.body };
        delete body.expectedUserID;
        req.body = body;
        next();
    } catch (error) { next(error); }
}

export function createAccountWriteScope() {
    let owner = null;
    let blocked = false;
    const capture = () => {
        if (blocked || owner === null) throw accountWriteError();
        return owner;
    };
    return {
        bind(userID) {
            if (blocked) throw accountWriteError();
            if (userID === null && owner === null) return;
            if (typeof userID !== 'string' || canonicalAccountID(userID) !== userID) {
                blocked = true;
                throw accountWriteError(userID === null ? 'account_changed' : 'account_identity_required');
            }
            if (owner !== null && owner !== userID) {
                blocked = true;
                throw accountWriteError();
            }
            owner = userID;
        },
        capture,
        invalidate() { if (owner !== null) blocked = true; },
        async write(request, path, body = {}) {
            const expectedUserID = capture();
            let result;
            try { result = await request(path, { ...body, expectedUserID }); }
            catch (error) {
                if (isAccountWriteError(error)) {
                    blocked = true;
                    throw accountWriteError(error.payload?.error ?? error.body?.error);
                }
                if (error.status === 401) blocked = true;
                throw error;
            }
            if (capture() !== expectedUserID) throw accountWriteError();
            return result;
        }
    };
}

// All page modules share the first account shown by this document.
export const pageAccountWriteScope = createAccountWriteScope();
