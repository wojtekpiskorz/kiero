# AI training consent and minimum-friction onboarding

Checked on 2026-09-08 against current EDPB primary guidance. This addresses the owner's proposal that a user consent to provider training to simplify GDPR handling. The owner subsequently deferred further formal discussion, requested minimal alpha setup and selected OpenRouter. The guidance below is retained as research, not a legal sign-off or a newly imposed approval gate. Alpha status has not been established as an exemption from the rules described here.

## Consent is one possible legal basis

GDPR provides several legal bases. If relying on consent, it must be freely given, specific, informed and unambiguous, with an easy withdrawal path. EDPB separates consent from general terms and distinguishes different processing purposes. Adding a purpose requires addressing its legal basis rather than assuming an earlier acceptance covers it. Necessary contractual processing is also bounded by what the service actually requires. [EDPB lawful processing guide](https://www.edpb.europa.eu/sme/be-compliant/process-personal-data-lawfully_en)

Application inference: a boss's acceptance is not automatically the consent of clients or workers mentioned in records. A firm's processor authorization differs from individual consent. Training needs a separately assessed purpose and lawful basis; this does not mean consent is always required or training is always unlawful.

## Roles and contracts remain relevant

A controller determines purposes and means, while a processor acts on the controller's instructions. Controller-processor relationships require a contract; appointing subprocessors requires authorization and corresponding contractual protection. [EDPB controller/processor guide](https://www.edpb.europa.eu/sme/learn-the-basics/data-controller-or-data-processor_en)

Working hypothesis to assess for the final service: the construction firm controls its project records, Kiero processes them for that service, and approved API suppliers form part of the processing chain. Kiero may separately control its own account and operational purposes. A provider using records for its own model training can change the purpose and role analysis. Neither one checkbox nor a vendor's label settles those roles for every operation.

## International processing is a separate question

Transfers outside the EEA require a Chapter V mechanism in addition to the ordinary lawful basis, minimization, security and processor-contract requirements. Adequacy and appropriate safeguards such as SCCs are the principal routes; derogations including explicit consent have limited conditions and are not a blanket substitute. The applicable provider, country, subprocessors and transfer arrangements need assessment. [EDPB international-transfer guide](https://www.edpb.europa.eu/sme/be-compliant/international-data-transfers_en)

Kiero's accepted preference for EU database/media/backups does not establish the location of every API processing or support operation. Conversely, choosing no-training API terms does not by itself prove transfer compliance. The owner's acceptance of AI outside the EU is a product constraint, not legal authorization for any provider.

## Proposed onboarding policy

Recommend no provider training on customer content in v1, with a documented no-training API configuration and the agreed retention constraints verified for every provider and fallback. Explain necessary AI processing in concise service/privacy information and put the proper processing terms in place. Do not add a compulsory training checkbox as a shortcut to compliance. This reduces a separate consent workflow rather than pretending ordinary service processing has no legal obligations.

Any later use of real records to train models should be a separately scoped decision covering actual affected data subjects, purpose, lawful basis, withdrawal or other applicable rights, and provider deletion behavior. The concrete role analysis, contracts, notices and transfer mechanism still need legal review before alpha. No user data was sent to an AI provider in this research, and no training consent was collected.
